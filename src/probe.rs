//! Media sniffing from container headers. Never decodes media, never panics on any input.

use crate::model::MediaKind;
use imagesize::ImageType;
use std::path::Path;

/// What the bytes say about themselves. Zero means unknown.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Probe {
    /// `None` when the content is not a recognised container.
    pub kind: Option<MediaKind>,
    pub width: u32,
    pub height: u32,
    /// Seconds.
    pub duration: f64,
}

#[must_use]
pub fn probe(data: &[u8]) -> Probe {
    probe_mp4(data)
        .or_else(|| probe_image(data))
        .or_else(|| probe_mp3(data))
        .unwrap_or_default()
}

/// Fallback when `probe` cannot tell: guess from MIME type and file extension.
#[must_use]
pub fn kind_from_name(file_name: &str, mime: Option<&str>) -> MediaKind {
    let mime = mime.unwrap_or_default().to_ascii_lowercase();
    let ext = Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if mime.starts_with("image/") {
        if mime == "image/gif" || ext == "gif" {
            return MediaKind::Animation;
        }
        return MediaKind::Photo;
    }
    if mime.starts_with("audio/") {
        return MediaKind::Audio;
    }
    if mime.starts_with("video/") {
        if mime.contains("gif") {
            return MediaKind::Animation;
        }
        return MediaKind::Video;
    }
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" => MediaKind::Photo,
        "gif" => MediaKind::Animation,
        "mp4" | "mov" | "m4v" | "webm" => MediaKind::Video,
        "mp3" | "m4a" | "aac" | "ogg" | "opus" | "wav" => MediaKind::Audio,
        _ => MediaKind::Document,
    }
}

/// File extension and MIME type by magic bytes. Headers and file names from the network are
/// often missing or wrong, and Telegram decides how to treat an upload from exactly these two.
#[must_use]
pub fn container(data: &[u8]) -> Option<(&'static str, &'static str)> {
    Some(match data {
        [0xFF, 0xD8, 0xFF, ..] => ("jpg", "image/jpeg"),
        [0x89, b'P', b'N', b'G', ..] => ("png", "image/png"),
        [b'G', b'I', b'F', b'8', ..] => ("gif", "image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ("webp", "image/webp"),
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => ("mp4", "video/mp4"),
        [b'I', b'D', b'3', ..] | [0xFF, 0xE0..=0xFF, ..] => ("mp3", "audio/mpeg"),
        _ => return None,
    })
}

fn be_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(*data.get(at..)?.first_chunk()?))
}

fn be_u64(data: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(*data.get(at..)?.first_chunk()?))
}

/// The ISO-BMFF boxes laid end to end in `data`, as (type, payload). Ends at the first box that
/// does not fit. Each step consumes at least a header, so a walk is linear in `data.len()`
/// whatever the sizes claim.
fn boxes(mut data: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    std::iter::from_fn(move || {
        let (header, size) = match be_u32(data, 0)? {
            0 => (8, data.len()), // runs to the end of the file
            1 => (16, usize::try_from(be_u64(data, 8)?).ok()?),
            size => (8, usize::try_from(size).ok()?),
        };
        let found = (data.get(4..8)?, data.get(header..size)?);
        data = data.get(size..)?;
        Some(found)
    })
}

fn find<'a>(data: &'a [u8], kind: &[u8]) -> Option<&'a [u8]> {
    boxes(data).find(|b| b.0 == kind).map(|b| b.1)
}

// Only fixed paths are followed (moov/trak/mdia/hdlr, moof/traf/trun), so nesting depth is bounded
// by construction.
fn probe_mp4(data: &[u8]) -> Option<Probe> {
    let moov = find(data, b"moov")?;
    let mut picked = None;
    for (_, trak) in boxes(moov).filter(|b| b.0 == b"trak") {
        let handler = find(trak, b"mdia")
            .and_then(|mdia| find(mdia, b"hdlr"))
            .and_then(|hdlr| hdlr.get(8..12));
        match handler {
            Some(b"vide") => {
                picked = Some((MediaKind::Video, trak));
                break;
            }
            Some(b"soun") if picked.is_none() => picked = Some((MediaKind::Audio, trak)),
            _ => {}
        }
    }
    let (kind, trak) = picked?;
    let duration = find(moov, b"mvhd")
        .and_then(mvhd_duration)
        .filter(|seconds| *seconds > 0.0)
        .or_else(|| fragment_duration(data, moov, trak))
        .unwrap_or(0.0);
    let (width, height) = find(trak, b"tkhd")
        .filter(|_| kind == MediaKind::Video)
        .and_then(tkhd_size)
        .unwrap_or_default();
    Some(Probe {
        kind: Some(kind),
        width,
        height,
        duration,
    })
}

#[expect(clippy::cast_precision_loss, reason = "a tick count past 2^53 is not a real duration")]
fn seconds(ticks: u64, timescale: u32) -> Option<f64> {
    (timescale != 0).then(|| ticks as f64 / f64::from(timescale))
}

fn mvhd_duration(mvhd: &[u8]) -> Option<f64> {
    let (timescale, ticks) = match mvhd.first()? {
        0 => (be_u32(mvhd, 12)?, u64::from(be_u32(mvhd, 16)?)),
        1 => (be_u32(mvhd, 20)?, be_u64(mvhd, 24)?),
        _ => return None,
    };
    seconds(ticks, timescale)
}

/// The 32-bit field after the creation and modification times, which version 1 widens to 64 bits:
/// the track id in a `tkhd`, the timescale in an `mdhd`.
fn after_times(header: &[u8]) -> Option<u32> {
    match header.first()? {
        0 => be_u32(header, 12),
        1 => be_u32(header, 20),
        _ => None,
    }
}

/// Duration of `trak` summed over the movie fragments. ffmpeg's `empty_moov` writes the `moov`
/// before it has seen a sample, so there the `mvhd` has none.
fn fragment_duration(data: &[u8], moov: &[u8], trak: &[u8]) -> Option<f64> {
    let id = after_times(find(trak, b"tkhd")?)?;
    let timescale = after_times(find(find(trak, b"mdia")?, b"mdhd")?)?;
    // `trex` and `tfhd` both carry the track id right after their flags.
    let ours = |b: &(&[u8], &[u8]), kind: &[u8]| b.0 == kind && be_u32(b.1, 4) == Some(id);
    let trex_default = find(moov, b"mvex")
        .and_then(|mvex| boxes(mvex).find(|b| ours(b, b"trex")))
        .and_then(|trex| be_u32(trex.1, 12))
        .unwrap_or(0);
    let mut ticks = 0_u64;
    for (_, moof) in boxes(data).filter(|b| b.0 == b"moof") {
        for (_, traf) in boxes(moof).filter(|b| b.0 == b"traf") {
            let Some((_, tfhd)) = boxes(traf).find(|b| ours(b, b"tfhd")) else {
                continue;
            };
            let flags = be_u32(tfhd, 0)?;
            // The default sample duration (0x8) comes after a 64-bit base data offset (0x1) and a
            // sample description index (0x2), where those are present.
            let default = match flags & 0x8 {
                0 => trex_default,
                _ => be_u32(tfhd, 8 + optional(flags, 0x1) * 2 + optional(flags, 0x2))?,
            };
            for (_, trun) in boxes(traf).filter(|b| b.0 == b"trun") {
                ticks = ticks.checked_add(trun_ticks(trun, default)?)?;
            }
        }
    }
    seconds(ticks, timescale)
}

/// Bytes taken by the optional 32-bit fields that the bits of `mask` switch on in `flags`.
fn optional(flags: u32, mask: u32) -> usize {
    (flags & mask).count_ones() as usize * 4
}

/// Ticks in one track run. The sample count is attacker-chosen: it is believed only as far as the
/// box holds entries for it, and never iterated without them.
fn trun_ticks(trun: &[u8], default: u32) -> Option<u64> {
    let flags = be_u32(trun, 0)?;
    let count = usize::try_from(be_u32(trun, 4)?).ok()?;
    // A data offset (0x1) and first-sample flags (0x4) may precede the per-sample entries, which
    // hold a duration (0x100), then a size, flags and a composition offset, each if flagged.
    let entries = trun.get(8 + optional(flags, 0x5)..)?;
    let entry = optional(flags, 0xF00);
    if flags & 0x100 != 0 {
        let mut samples = entries.chunks_exact(entry).take(count);
        return samples.try_fold(0_u64, |sum, sample| sum.checked_add(be_u32(sample, 0)?.into()));
    }
    let count = entries.len().checked_div(entry).map_or(count, |held| count.min(held));
    u64::try_from(count).ok()?.checked_mul(default.into())
}

/// Displayed size of a track: its 16.16 fixed-point width and height, swapped when the matrix
/// turns the picture on its side.
fn tkhd_size(tkhd: &[u8]) -> Option<(u32, u32)> {
    // The matrix comes after the version-dependent timestamps; width and height come after it.
    let matrix = match tkhd.first()? {
        0 => 40,
        1 => 52,
        _ => return None,
    };
    let word = |index: usize| be_u32(tkhd, matrix + index * 4);
    let (width, height) = (word(9)? >> 16, word(10)? >> 16);
    // [a b u; c d v; x y w]: a quarter turn has a = d = 0 and carries its ±1 in b and c.
    if word(0)? == 0 && word(4)? == 0 && word(1)? != 0 && word(3)? != 0 {
        return Some((height, width));
    }
    Some((width, height))
}

fn probe_image(data: &[u8]) -> Option<Probe> {
    // imagesize also matches formats with weak or no signatures (TGA, ICO, PNM, ...). Only these
    // four get through, so arbitrary bytes cannot pass for a picture.
    let kind = match imagesize::image_type(data).ok()? {
        ImageType::Gif => MediaKind::Animation,
        ImageType::Jpeg | ImageType::Png | ImageType::Webp => MediaKind::Photo,
        _ => return None,
    };
    let size = imagesize::blob_size(data).ok()?;
    Some(Probe {
        kind: Some(kind),
        width: u32::try_from(size.width).ok()?,
        height: u32::try_from(size.height).ok()?,
        duration: 0.0,
    })
}

fn frame_sync(data: &[u8]) -> bool {
    matches!(data, [0xFF, second, ..] if *second >= 0xE0)
}

fn probe_mp3(data: &[u8]) -> Option<Probe> {
    // mp3-duration checks no signature: empty, all-zero or tag-only input is Ok(0) to it.
    if !(data.starts_with(b"ID3") || frame_sync(data)) || xing_overflows(data) {
        return None;
    }
    let mut reader = data;
    let duration = mp3_duration::from_read(&mut reader).ok()?;
    (!duration.is_zero()).then(|| Probe {
        kind: Some(MediaKind::Audio),
        duration: duration.as_secs_f64(),
        ..Probe::default()
    })
}

/// mp3-duration 0.1.10 converts the frame count of a Xing/Info header to nanoseconds with an
/// unchecked `u64` multiplication, which panics under overflow checks. It reads that header 13,
/// 21 or 36 bytes after a frame sync, so the file is turned away if any such place holds a count
/// past what fits: 16 million frames of 1152 samples, days of audio.
// shortcut: on 32-bit targets its APE tag skip can overflow `usize` too; guard that before
// shipping to one.
fn xing_overflows(data: &[u8]) -> bool {
    let absurd = |tag: &[u8]| {
        (tag.starts_with(b"Xing") || tag.starts_with(b"Info")) && be_u32(tag, 8) > Some(16_000_000)
    };
    (0..data.len()).filter_map(|at| data.get(at..)).any(|rest| {
        let tag = |skip| rest.get(skip..).unwrap_or_default();
        frame_sync(rest) && [13, 21, 36].into_iter().any(|skip| absurd(tag(skip)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! fixture {
        ($name:literal, $($expected:expr),+) => {
            ($name, include_bytes!(concat!("../tests/fixtures/", $name)).as_slice(), $($expected),+)
        };
    }

    /// Name, bytes, then kind, width, height and seconds as `ffprobe` reports them.
    type Fixture = (&'static str, &'static [u8], MediaKind, u32, u32, f64);

    const FIXTURES: &[Fixture] = &[
        fixture!("moov_end.mp4", MediaKind::Video, 64, 48, 2.0),
        fixture!("faststart.mp4", MediaKind::Video, 64, 48, 2.0),
        // ffprobe: coded 64x48 with a 90° display matrix.
        fixture!("rotated.mp4", MediaKind::Video, 48, 64, 2.0),
        fixture!("audio.m4a", MediaKind::Audio, 0, 0, 2.0),
        fixture!("photo.jpg", MediaKind::Photo, 64, 48, 0.0),
        fixture!("photo.png", MediaKind::Photo, 64, 48, 0.0),
        // ffprobe says 1.5 s; GIF duration is not probed.
        fixture!("anim.gif", MediaKind::Animation, 64, 48, 0.0),
        // ID3v2 tag and Info header. ffprobe trims the encoder padding; the frame count says 1.071.
        fixture!("tagged.mp3", MediaKind::Audio, 0, 0, 1.0),
        // Neither tag nor Info header: starts on a frame sync and every frame gets walked.
        fixture!("bare.mp3", MediaKind::Audio, 0, 0, 1.071),
        // Fragmented with an empty moov, as cobalt pipes its remuxes. The video stream lasts 3.0 s;
        // ffprobe's container figure of 3.4 s adds the two frames (at 5 fps) of B-frame delay.
        fixture!("fragmented.mp4", MediaKind::Video, 64, 48, 3.0),
        fixture!("fragmented.m4a", MediaKind::Audio, 0, 0, 3.128),
    ];

    #[test]
    fn fixtures_match_ffprobe() {
        for &(name, data, kind, width, height, seconds) in FIXTURES {
            let p = probe(data);
            assert_eq!((p.kind, p.width, p.height), (Some(kind), width, height), "{name}");
            assert!((p.duration - seconds).abs() < 0.1, "{name}: {}", p.duration);
        }
    }

    fn boxed(kind: &[u8], body: &[u8]) -> Vec<u8> {
        let size = u32::try_from(body.len() + 8).unwrap();
        [size.to_be_bytes().as_slice(), kind, body].concat()
    }

    /// What ffmpeg does not write for small files: version 1 `mvhd` and `tkhd`, a 64-bit box
    /// size (the `mdat`) and a box of size 0 (the `moov`).
    fn wide_mp4(timescale: u32) -> Vec<u8> {
        let mut mvhd = vec![0; 32];
        mvhd[0] = 1;
        mvhd[20..24].copy_from_slice(&timescale.to_be_bytes());
        mvhd[24..32].copy_from_slice(&5_000_000_000_u64.to_be_bytes());
        let mut tkhd = vec![0; 96];
        tkhd[0] = 1;
        tkhd[52..56].copy_from_slice(&0x1_0000_u32.to_be_bytes());
        tkhd[68..72].copy_from_slice(&0x1_0000_u32.to_be_bytes());
        tkhd[88..92].copy_from_slice(&(1920_u32 << 16).to_be_bytes());
        tkhd[92..96].copy_from_slice(&(1080_u32 << 16).to_be_bytes());
        let hdlr = boxed(b"hdlr", b"\0\0\0\0\0\0\0\0vide");
        let trak = [boxed(b"tkhd", &tkhd), boxed(b"mdia", &hdlr)].concat();
        let moov = [boxed(b"mvhd", &mvhd), boxed(b"trak", &trak)].concat();
        let mut file = b"\0\0\0\x01mdat\0\0\0\0\0\0\0\x14wxyz\0\0\0\0moov".to_vec();
        file.extend(moov);
        file
    }

    #[test]
    fn mp4_wide_layouts() {
        let expected = Probe {
            kind: Some(MediaKind::Video),
            width: 1920,
            height: 1080,
            duration: 5_000_000.0,
        };
        assert_eq!(probe(&wide_mp4(1000)), expected);
        let zero_timescale = Probe {
            duration: 0.0,
            ..expected
        };
        assert_eq!(probe(&wide_mp4(0)), zero_timescale);
    }

    fn words(values: &[u32]) -> Vec<u8> {
        values.iter().flat_map(|value| value.to_be_bytes()).collect()
    }

    /// What ffmpeg did not write into the fragmented fixtures: a run timed by the `trex` default,
    /// runs claiming a thousand samples but holding two, a `tfhd` with a base data offset, and a
    /// fragment of another track.
    #[test]
    fn mp4_fragment_durations() {
        let fragment = |tfhd: &[u32], trun: &[u32]| {
            let inner = [boxed(b"tfhd", &words(tfhd)), boxed(b"trun", &words(trun))];
            boxed(b"traf", &inner.concat())
        };
        let fragments = [
            // 3 samples x 100 ticks from the trex.
            fragment(&[0, 7], &[0, 3]),
            // 2 sizes present x 20 ticks from the tfhd, where a base data offset comes first.
            fragment(&[0x9, 7, 0, 0, 20], &[0x200, 1000, 11, 22]),
            // Durations 5 and 6, each followed by a size, after a data offset.
            fragment(&[0x8, 7, 20], &[0x301, 1000, 99, 5, 11, 6, 22]),
            // Track 9 is not ours.
            fragment(&[0x8, 9, 50], &[0, 3]),
        ];
        let header = words(&[0, 0, 0, 1000, 0]);
        let hdlr = boxed(b"hdlr", b"\0\0\0\0\0\0\0\0soun");
        let mdia = boxed(b"mdia", &[boxed(b"mdhd", &header), hdlr].concat());
        let trak = boxed(b"trak", &[boxed(b"tkhd", &words(&[0, 0, 0, 7])), mdia].concat());
        let mvex = boxed(b"mvex", &boxed(b"trex", &words(&[0, 7, 1, 100, 0, 0])));
        let moov = boxed(b"moov", &[boxed(b"mvhd", &header), trak, mvex].concat());
        let file = [moov, boxed(b"moof", &fragments.concat())].concat();
        let expected = Probe {
            kind: Some(MediaKind::Audio),
            duration: 0.351,
            ..Probe::default()
        };
        assert_eq!(probe(&file), expected);
    }

    #[test]
    fn mp3_without_frames_is_not_audio() {
        assert_eq!(probe(&[0; 4096]), Probe::default());
        assert_eq!(probe(b"ID3\x04\0\0\0\0\0\0"), Probe::default());
    }

    #[test]
    fn survives_damaged_input() {
        for &(_, data, ..) in FIXTURES {
            for end in 0..data.len() {
                let _ = probe(&data[..end]);
            }
            let mut damaged = data.to_vec();
            for at in 0..damaged.len() {
                let original = damaged[at];
                for value in [0x00, 0xFF, original ^ 0x01, original ^ 0x80] {
                    damaged[at] = value;
                    let _ = probe(&damaged);
                }
                damaged[at] = original;
            }
        }
    }

    #[test]
    fn kind_from_name_table() {
        let table = [
            ("a.bin", Some("image/jpeg"), MediaKind::Photo),
            ("a.bin", Some("IMAGE/GIF"), MediaKind::Animation),
            ("a.GIF", Some("image/webp"), MediaKind::Animation),
            ("a.jpg", Some("audio/mpeg"), MediaKind::Audio),
            ("a.jpg", Some("video/mp4; codecs=avc1"), MediaKind::Video),
            ("a.mp4", Some("video/x-gif"), MediaKind::Animation),
            ("a.JPeG", None, MediaKind::Photo),
            ("a.png", Some(""), MediaKind::Photo),
            ("a.webp", Some("application/octet-stream"), MediaKind::Photo),
            ("a.gif", None, MediaKind::Animation),
            ("a.mp4", None, MediaKind::Video),
            ("clip.final.mov", None, MediaKind::Video),
            ("a.m4v", None, MediaKind::Video),
            ("a.webm", None, MediaKind::Video),
            ("a.mp3", None, MediaKind::Audio),
            ("a.m4a", None, MediaKind::Audio),
            ("a.aac", None, MediaKind::Audio),
            ("a.ogg", None, MediaKind::Audio),
            ("a.opus", None, MediaKind::Audio),
            ("a.wav", None, MediaKind::Audio),
            ("a.pdf", None, MediaKind::Document),
            ("mp4", None, MediaKind::Document),
            (".mp4", None, MediaKind::Document),
            ("", None, MediaKind::Document),
        ];
        for (file_name, mime, kind) in table {
            assert_eq!(kind_from_name(file_name, mime), kind, "{file_name} {mime:?}");
        }
    }
}
