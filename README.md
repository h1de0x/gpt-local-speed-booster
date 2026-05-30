# GPT Local Speed Booster

A **Firefox-only** extension that reduces lag in very long ChatGPT conversations by locally trimming older messages before the page renders them.

> **Firefox only.**  
> This extension is currently built and tested for Firefox / Mozilla Add-ons.  
> Chrome, Edge, Safari, and other browsers are not supported at this time.

## Features

- Keeps recent ChatGPT messages visible in very long chats
- Lets you load previous messages when needed
- Uses local browser storage and IndexedDB cache for faster repeated loading
- Shows a small status badge only when trimming is active
- Does not send conversation content to any external server

## How it works

GPT Local Speed Booster runs locally on ChatGPT pages.

It intercepts ChatGPT conversation responses in the browser, trims older visible messages from the conversation tree, and returns a smaller local response to the page. This reduces rendering work in very long chats while keeping recent messages available.

Older messages can be loaded back in batches with the **Load previous messages** button.

## Privacy

This extension runs locally in your browser.

It reads ChatGPT conversation responses on `chatgpt.com` only to reduce rendering lag in long chats. Conversation data may be temporarily stored locally in the browser using `sessionStorage`, `localStorage`, and `IndexedDB`.

The extension does **not** transmit conversation content, analytics, identifiers, or personal data to the developer or to third-party servers.

All processing happens locally on the user's device. Local cached data can be cleared by resetting loaded messages, clearing site data, or uninstalling the extension.

See [PRIVACY.md](PRIVACY.md) for details.

## Browser support

| Browser | Status |
|---|---|
| Firefox | Supported |
| Firefox Developer Edition | Supported |
| Firefox Nightly | Likely supported |
| Chrome | Not supported |
| Edge | Not supported |
| Safari | Not supported |

## Development

This project targets Firefox Manifest V3.

```bash
npm install
npx web-ext lint --source-dir extension
npx web-ext run --source-dir extension --target firefox-desktop
```

## Build for Firefox / AMO

```bash
npx web-ext build --source-dir extension --artifacts-dir dist
```

The resulting ZIP in `dist/` is the package to upload to addons.mozilla.org.

## Repository structure

```text
.
├── extension/
│   ├── manifest.json
│   ├── icons/
│   └── src/
├── README.md
├── PRIVACY.md
├── LICENSE
├── package.json
└── web-ext-config.mjs
```

## Copyright

Copyright (c) 2026 H1de0x.

## License

MIT
