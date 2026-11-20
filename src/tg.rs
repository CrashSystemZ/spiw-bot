//! The few Telegram calls the bot needs that grammers has no safe wrapper for.

use std::{io::Cursor, time::Duration};

use grammers_client::{Client, InvocationError, tl};
use tokio::sync::Mutex;

use crate::{
    error::{Error, Result},
    model::{FileRef, MediaKind},
    probe::Probe,
};

pub type InlineId = tl::enums::InputBotInlineMessageId;

pub struct Upload<'a> {
    pub data: &'a [u8],
    pub name: &'a str,
    pub mime: &'a str,
    pub kind: MediaKind,
    pub probe: Probe,
}

pub struct Tg {
    pub client: Client,
    home_dc: i32,
    /// Datacenters our login has already been copied to.
    authorized: Mutex<Vec<i32>>,
}

impl Tg {
    pub fn new(client: Client, home_dc: i32) -> Self {
        Self { client, home_dc, authorized: Mutex::new(Vec::new()) }
    }

    /// Stores a file on Telegram and returns a reference that can be sent any number of times.
    ///
    /// An inline message cannot take a fresh upload directly, so the file is first
    /// turned into a document via `messages.uploadMedia`.
    pub async fn upload(&self, upload: Upload<'_>) -> Result<FileRef> {
        let Upload { data, name, mime, kind, probe } = upload;
        let file = self
            .client
            .upload_stream(&mut Cursor::new(data), data.len(), name.to_owned())
            .await
            .map_err(|e| Error::Unavailable(format!("upload: {e}")))?
            .raw;

        let media: tl::enums::InputMedia = if kind == MediaKind::Photo {
            tl::types::InputMediaUploadedPhoto { spoiler: false, live_photo: false, file, stickers: None, ttl_seconds: None, video: None }.into()
        } else {
            let mut attributes = vec![tl::types::DocumentAttributeFilename { file_name: name.to_owned() }.into()];
            match kind {
                MediaKind::Video | MediaKind::Animation => {
                    attributes.push(
                        tl::types::DocumentAttributeVideo {
                            round_message: false,
                            supports_streaming: true,
                            nosound: false,
                            duration: probe.duration,
                            w: i32::try_from(probe.width).unwrap_or(0),
                            h: i32::try_from(probe.height).unwrap_or(0),
                            preload_prefix_size: None,
                            video_start_ts: None,
                            video_codec: None,
                        }
                        .into(),
                    );
                    if kind == MediaKind::Animation {
                        attributes.push(tl::enums::DocumentAttribute::Animated);
                    }
                }
                MediaKind::Audio => attributes.push(
                    #[expect(clippy::cast_possible_truncation, reason = "durations are far below i32::MAX seconds")]
                    tl::types::DocumentAttributeAudio { voice: false, duration: probe.duration as i32, title: None, performer: None, waveform: None }
                        .into(),
                ),
                MediaKind::Photo | MediaKind::Document => {}
            }
            tl::types::InputMediaUploadedDocument {
                nosound_video: false,
                force_file: kind == MediaKind::Document,
                spoiler: false,
                file,
                thumb: None,
                mime_type: mime.to_owned(),
                attributes,
                stickers: None,
                video_cover: None,
                video_timestamp: None,
                ttl_seconds: None,
            }
            .into()
        };

        let request = tl::functions::messages::UploadMedia { business_connection_id: None, peer: tl::enums::InputPeer::PeerSelf, media };
        match self.client.invoke(&request).await? {
            tl::enums::MessageMedia::Photo(tl::types::MessageMediaPhoto { photo: Some(tl::enums::Photo::Photo(photo)), .. }) => {
                Ok(FileRef { kind, id: photo.id, access_hash: photo.access_hash, file_reference: photo.file_reference })
            }
            tl::enums::MessageMedia::Document(tl::types::MessageMediaDocument {
                document: Some(tl::enums::Document::Document(document)), ..
            }) => Ok(FileRef { kind, id: document.id, access_hash: document.access_hash, file_reference: document.file_reference }),
            _ => Err(Error::Internal("telegram returned no file for the upload".into())),
        }
    }

    /// Replaces the content of an inline message. `text` is the caption when `media` is given.
    /// The placeholder's keyboard is dropped in the same call.
    pub async fn edit(&self, id: &InlineId, text: &str, media: Option<&FileRef>) -> std::result::Result<(), InvocationError> {
        // inline messages live in the datacenter of whoever sent them
        let dc = match id {
            InlineId::Id(id) => id.dc_id,
            InlineId::Id64(id) => id.dc_id,
        };
        let request = tl::functions::messages::EditInlineBotMessage {
            no_webpage: true,
            invert_media: false,
            id: id.clone(),
            message: Some(text.to_owned()),
            media: media.map(input_media),
            reply_markup: None,
            entities: None,
            rich_message: None,
        };
        // Telegram occasionally reports a file it has just accepted as empty
        let mut attempts = 3;
        loop {
            self.authorize(dc).await?;
            attempts -= 1;
            match self.client.invoke_in_dc(dc, &request).await {
                Ok(_) => return Ok(()),
                Err(e) if e.is("MESSAGE_NOT_MODIFIED") => return Ok(()),
                Err(e) if attempts > 0 && e.is("MEDIA_EMPTY") => tokio::time::sleep(Duration::from_millis(400)).await,
                Err(InvocationError::Rpc(e)) if attempts > 0 && e.code == 401 => self.authorized.lock().await.retain(|known| *known != dc),
                Err(e) => return Err(e),
            }
        }
    }

    /// Copies our login to another datacenter; a connection there starts out anonymous.
    async fn authorize(&self, dc: i32) -> std::result::Result<(), InvocationError> {
        if dc == self.home_dc {
            return Ok(());
        }
        let mut authorized = self.authorized.lock().await;
        if authorized.contains(&dc) {
            return Ok(());
        }
        let tl::enums::auth::ExportedAuthorization::Authorization(exported) =
            self.client.invoke(&tl::functions::auth::ExportAuthorization { dc_id: dc }).await?;
        self.client.invoke_in_dc(dc, &tl::functions::auth::ImportAuthorization { id: exported.id, bytes: exported.bytes }).await?;
        authorized.push(dc);
        Ok(())
    }
}

fn input_media(file: &FileRef) -> tl::enums::InputMedia {
    let FileRef { kind, id, access_hash, file_reference } = file.clone();
    if kind == MediaKind::Photo {
        tl::types::InputMediaPhoto {
            spoiler: false,
            live_photo: false,
            id: tl::types::InputPhoto { id, access_hash, file_reference }.into(),
            ttl_seconds: None,
            video: None,
        }
        .into()
    } else {
        tl::types::InputMediaDocument {
            spoiler: false,
            id: tl::types::InputDocument { id, access_hash, file_reference }.into(),
            video_cover: None,
            video_timestamp: None,
            ttl_seconds: None,
            query: None,
        }
        .into()
    }
}

/// Telegram no longer accepts a stored file reference; the file has to be uploaded again.
pub fn is_stale_file(error: &InvocationError) -> bool {
    error.is("FILE_REFERENCE_*") || error.is("MEDIA_EMPTY") || error.is("FILE_ID_INVALID")
}
