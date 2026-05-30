# Privacy Policy

GPT Local Speed Booster is designed to run locally in your browser.

## Data processed locally

The extension reads ChatGPT conversation responses on `chatgpt.com` only to reduce rendering lag in long chats. The extension may temporarily store conversation data locally using:

- `sessionStorage`
- `localStorage`
- `IndexedDB`
- Firefox extension storage

This local storage is used for extension settings, scroll restoration, loaded-message state, and local caching for faster repeated loading.

## Data transmission

The extension does not transmit conversation content, analytics, identifiers, or personal data to the developer or to third-party servers.

There is no remote analytics, telemetry, tracking pixel, external API, or developer-operated backend.

## Host permissions

The extension requests access to:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

These permissions are required to intercept ChatGPT conversation responses locally and reduce the amount of conversation data rendered in long chats.

## Clearing local data

Local cached data can be removed by:

- using the extension's reset controls where available
- clearing site data for ChatGPT in the browser
- disabling or uninstalling the extension
