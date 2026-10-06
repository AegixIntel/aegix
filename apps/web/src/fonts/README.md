# Fonts

The Latin subsets of the three families the site uses, as served by Google
Fonts on 6 October 2026. They are loaded with `next/font/local` in
`src/app/layout.tsx`, so a build needs no network for them.

| File | Family | Weights |
| --- | --- | --- |
| `ibm-plex-sans-latin.woff2` | IBM Plex Sans | 400 to 700, one variable file |
| `ibm-plex-mono-400-latin.woff2` | IBM Plex Mono | 400 |
| `ibm-plex-mono-500-latin.woff2` | IBM Plex Mono | 500 |
| `ibm-plex-mono-600-latin.woff2` | IBM Plex Mono | 600 |
| `newsreader-latin.woff2` | Newsreader | 200 to 800, without the optical-size axis |

Both families are licensed under the SIL Open Font License 1.1
(<https://openfontlicense.org>): IBM Plex, copyright IBM Corp.; Newsreader,
copyright The Newsreader Project Authors.

Only the Latin subset is here. The Google build also offered Latin Extended,
Cyrillic, Greek and Vietnamese files, which a browser fetched only for text in
those scripts; such text now falls back to the system font.
