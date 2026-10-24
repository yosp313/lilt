# Lilt

A bot-free meeting notepad: dual-stream capture, live transcript, notes you keep.

## Overview

Lilt is a desktop app that captures your computer's audio plus your microphone locally, without joining the meeting as a bot. It produces private notes that you can enhance with AI assistance.

## Features

- **Bot-free capture**: No need to join Zoom, Meet, or Teams calls
- **Dual-stream transcription**: Separate transcripts for system audio ("Them") and your microphone ("Me")
- **AI-enhanced notes**: Enhance your rough notes during/after meetings using the transcript as context
- **Calendar integration**: Google Calendar and Outlook (Microsoft) sync with one-click meeting start
- **Offline first**: Local Whisper models for transcription, with optional cloud STT providers

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run start

# Build
npm run package

# Run linting
npm run lint

# Typecheck
npm run typecheck

# Run tests
npm test
```

## Architecture

- **Frontend**: Electron app with preact
- **Main process**: Audio capture, transcription, calendar sync
- **Local STT**: Whisper models (downloaded locally)
- **AI Completion**: OpenAI-compatible endpoint (supports any provider like Groq, OpenRouter, etc.)

## Configuration

### Adding a new AI provider (e.g., Groq)

1. Go to **Settings → Intelligence**
2. Set **Base URL** to `https://api.groq.com/openai/v1`
3. Enter your Groq API key
4. Set **Chat model** to a Groq model name (e.g., `llama-3.3-70b-versatile`)

Common Groq model names:
- `llama-3.3-70b-versatile`
- `llama-3.1-8b-instant`
- `mixtral-8x7b-32768`
- `gemma2-9b-it`

### Local Speech-to-Text

Download a local Whisper model in **Settings → Intelligence → Speech source**:
- `whisper-tiny` (~75MB) - Fastest, lowest quality
- `whisper-small` (~2.5GB) - Balanced
- `whisper-medium` (~5GB) - Higher quality
- `whisper-large` (~6GB) - Highest quality

## Building Whisper Models

```bash
npm run build:whisper
```

## License

MIT