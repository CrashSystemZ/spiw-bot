mod bot;
mod cobalt;
mod config;
mod db;
mod error;
mod meta;
mod model;
mod net;
mod probe;
mod tg;
mod url;

use std::{error::Error, process::ExitCode, sync::Arc, time::Duration};

use grammers_client::{
    Client, SenderPool,
    sender::UpdatesConfiguration,
    session::{
        Session,
        storages::MemorySession,
        types::{DcOption, UpdateState, UpdatesState},
    },
    tl,
};
use sha2::{Digest, Sha256};
use tokio::{
    signal::unix::{SignalKind, signal},
    task::JoinSet,
};
use tracing::{error, info, warn};

use crate::{bot::App, config::Config, db::Db, tg::Tg};

/// Updates handled at once; anything beyond this is dropped rather than queued without bound.
const MAX_HANDLERS: usize = 512;

type Fallible<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[tokio::main]
async fn main() -> ExitCode {
    let cfg = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(error) => {
            eprintln!("configuration error: {error}");
            return ExitCode::FAILURE;
        }
    };
    // no timestamps: the container runtime adds its own
    tracing_subscriber::fmt().with_max_level(cfg.log_level).without_time().init();

    match run(cfg).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            error!(%error, "fatal");
            ExitCode::FAILURE
        }
    }
}

async fn run(cfg: Config) -> Fallible<()> {
    let db = Db::open(&cfg.db_path)?;

    // Signing in on every start is rate limited by Telegram and would lock a
    // crash-looping bot out, so the login key is kept between runs.
    let session = Arc::new(MemorySession::default());
    let slot = format!("session:{}", model::hex(&Sha256::digest(&cfg.bot_token)[..8]));
    restore_session(&db, &session, &slot).await;

    let SenderPool { runner, handle, updates } = SenderPool::new(Arc::clone(&session), cfg.api_id);
    let client = Client::new(handle.clone());
    let mut pool = tokio::spawn(runner.run());

    match client.is_authorized().await {
        Ok(true) => {}
        Ok(false) => {
            client.bot_sign_in(&cfg.bot_token, &cfg.api_hash).await?;
            info!("signed in");
        }
        Err(error) => {
            // a saved key that Telegram rejects for good would fail every restart the same way
            let _ = db.kv_set(&slot, &[]);
            return Err(error.into());
        }
    }
    save_session(&db, &session, &slot);

    // grammers notices gaps in the update stream, and reconnects to fill them, only once it
    // knows the current update state; with an in-memory session nothing fetches it for us
    let tl::enums::updates::State::State(state) = client.invoke(&tl::functions::updates::GetState {}).await?;
    let state = UpdatesState { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq, channels: Vec::new() };
    session.set_update_state(UpdateState::All(state)).await?;
    let mut updates = client.stream_updates(updates, UpdatesConfiguration { catch_up: true }).await?;

    // A lost connection is only re-established by the next request, and an idle bot makes
    // none. This is that request; the task ends when Telegram stops answering.
    let pinger = client.clone();
    let mut watchdog = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let ping = pinger.invoke(&tl::functions::updates::GetState {});
            if !matches!(tokio::time::timeout(Duration::from_secs(30), ping).await, Ok(Ok(_))) {
                return;
            }
        }
    });

    let app = App::new(cfg, db, Tg::new(client, session.home_dc_id()?))?;

    let janitor = Arc::clone(&app);
    tokio::spawn(async move {
        let mut hourly = tokio::time::interval(Duration::from_secs(3600));
        loop {
            hourly.tick().await;
            janitor.cleanup();
        }
    });

    info!("bot started");
    let mut handlers = JoinSet::new();
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let outcome = loop {
        tokio::select! {
            _ = terminate.recv() => break Ok(()),
            _ = interrupt.recv() => break Ok(()),
            _ = &mut pool => break Err("connection to telegram closed".into()),
            _ = &mut watchdog => break Err("telegram stopped answering".into()),
            update = updates.next() => match update {
                Ok(_) if handlers.len() >= MAX_HANDLERS => warn!("overloaded, dropping an update"),
                Ok(update) => drop(handlers.spawn(Arc::clone(&app).handle(update))),
                Err(error) => break Err(error.into()),
            },
            Some(done) = handlers.join_next(), if !handlers.is_empty() => {
                if done.is_err_and(|e| e.is_panic()) {
                    error!("an update handler panicked");
                }
            }
        }
    };

    info!("shutting down");
    // let deliveries that are already under way finish; the container gets 10 s to stop
    let drain = async { while handlers.join_next().await.is_some() {} };
    let _ = tokio::time::timeout(Duration::from_secs(8), drain).await;
    handle.quit();
    outcome
}

async fn restore_session(db: &Db, session: &MemorySession, slot: &str) {
    let Ok(Some(saved)) = db.kv_get(slot) else { return };
    let dc = saved.get(..4).and_then(|b| b.try_into().ok()).map(i32::from_le_bytes);
    let key = saved.get(4..).and_then(|b| <[u8; 256]>::try_from(b).ok());
    let (Some(dc), Some(key)) = (dc, key) else { return };
    let Ok(Some(option)) = session.dc_option(dc) else { return };
    let restored = session.set_dc_option(&DcOption { auth_key: Some(key), ..option }).await.is_ok() && session.set_home_dc_id(dc).await.is_ok();
    if !restored {
        warn!("could not restore the saved telegram session");
    }
}

fn save_session(db: &Db, session: &MemorySession, slot: &str) {
    let Ok(dc) = session.home_dc_id() else { return };
    let Ok(Some(DcOption { auth_key: Some(key), .. })) = session.dc_option(dc) else { return };
    let saved = [&dc.to_le_bytes()[..], &key[..]].concat();
    if let Err(error) = db.kv_set(slot, &saved) {
        warn!(%error, "could not save the telegram session");
    }
}
