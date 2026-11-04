//! Live dictation bridge: 16 kHz mono s16le on stdin, JSON lines on stdout.
//!
//! Lilt spawns one process per audio source and writes decoded PCM as it
//! arrives; every text change is printed as one line so the app can render a
//! growing transcript line without re-implementing the streaming state machine.
//!
//!     transcribe-stream <model.gguf> [--language ar]
//!
//! Closing stdin finalizes the stream and exits.

use std::io::{BufReader, Read, Write};

use transcribe_cpp::{CommitPolicy, Model, RunOptions, StreamOptions};

/// 100 ms at 16 kHz, the chunk size the upstream streaming example uses.
const FRAME_SAMPLES: usize = 1600;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(model_path) = args.next() else {
        eprintln!("usage: transcribe-stream <model.gguf> [--language <code>]");
        std::process::exit(2);
    };
    let mut language: Option<String> = None;
    while let Some(arg) = args.next() {
        if arg == "--language" {
            language = args.next().filter(|value| value != "auto");
        }
    }

    if let Err(error) = transcribe_cpp::init_backends_default() {
        eprintln!("transcribe-stream: backend init failed: {error}");
        std::process::exit(1);
    }

    let model = match Model::load(&model_path) {
        Ok(model) => model,
        Err(error) => {
            eprintln!("transcribe-stream: cannot load model: {error}");
            std::process::exit(1);
        }
    };
    if !model.capabilities().supports_streaming {
        eprintln!(
            "transcribe-stream: {} is not a streaming model",
            model.arch()
        );
        std::process::exit(3);
    }

    // The app sends two-letter ISO codes ("en", "ar"); the model advertises
    // region-tagged ones ("en-US"). Match by prefix, and drop an unknown hint
    // so the stream autodetects instead of refusing to start.
    if let Some(requested) = language.take() {
        let prefix = format!("{requested}-");
        language = model
            .capabilities()
            .languages
            .into_iter()
            .find(|code| code == &requested || code.starts_with(&prefix));
    }

    let mut session = match model.session() {
        Ok(session) => session,
        Err(error) => {
            eprintln!("transcribe-stream: cannot open session: {error}");
            std::process::exit(1);
        }
    };
    let run = RunOptions {
        language,
        ..Default::default()
    };
    let options = StreamOptions {
        commit_policy: CommitPolicy::Auto,
        ..Default::default()
    };
    let mut stream = match session.stream(&run, &options) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("transcribe-stream: cannot start stream: {error}");
            std::process::exit(1);
        }
    };

    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let mut bytes = vec![0u8; FRAME_SAMPLES * 2];
    let mut samples: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES);

    loop {
        // Fill one whole frame; a short read at EOF flushes the remainder.
        let mut filled = 0;
        while filled < bytes.len() {
            match reader.read(&mut bytes[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    eprintln!("transcribe-stream: stdin failed: {error}");
                    std::process::exit(1);
                }
            }
        }
        if filled >= 2 {
            samples.clear();
            samples.extend(
                bytes[..filled - filled % 2]
                    .chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0),
            );
            match stream.feed(&samples) {
                Ok(update) if update.committed_changed || update.tentative_changed => {
                    emit(&mut out, &stream, false);
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("transcribe-stream: feed failed: {error}");
                    std::process::exit(1);
                }
            }
        }
        if filled < bytes.len() {
            break;
        }
    }

    if stream.finalize().is_ok() {
        emit(&mut out, &stream, true);
    }
    let _ = out.flush();
}

fn emit(out: &mut impl Write, stream: &transcribe_cpp::Stream<'_>, final_: bool) {
    let text = stream.text();
    let line = format!(
        "{{\"rev\":{},\"committed\":{},\"tentative\":{},\"final\":{}}}\n",
        stream.revision(),
        json(&text.committed),
        json(&text.tentative),
        final_
    );
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

/// Minimal JSON string escaping; the text is model output, not trusted input.
fn json(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
