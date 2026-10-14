# Label Cutter

An opinionated workflow for making consistently styled labels with a 40W xTool S1.

## Development

Install dependencies and start the local app:

```sh
pnpm install
pnpm run dev
```

Create a production build with:

```sh
pnpm run build
```

Vite writes the production files to `dist/`.

## xTool S1 USB protocol notes

The S1 USB workflow was reverse-engineered from USB captures of xTool Studio 1.9.11 communicating with a 40W xTool S1. Captures were taken while connecting, querying the machine, uploading a framing job, and uploading a max-bed job. The max-bed job is only a reference for the bed coordinates and usable area; the app does not send it to the laser.

The capture filter script uses `tshark` to list distinct USB devices and extract traffic for a selected vendor/product ID. For example:

```sh
python3 scripts/usb_capture.py list reference-files/laser-only/*.pcapng
python3 scripts/usb_capture.py filter --device 28e9:018a --out-dir /tmp/s1 reference-files/laser-only/*.pcapng
```

The filtered captures can be inspected in Wireshark. Studio's S1 connection uses newline-terminated text commands and responses, alongside binary upload frames. Each upload frame starts with `F3`, contains a length-prefixed payload and byte-sum checks, and ends with `F4`. Command `01` announces a file and its checksum; command `02` transfers file data in chunks of up to 16 KiB; the S1 acknowledges frames with command `F0`. The implementation is in [`src/s1.ts`](src/s1.ts); generated laser jobs are in [`src/gcode.ts`](src/gcode.ts).

The original captures are kept locally in `reference-files/` and excluded from Git, since USB captures may include unrelated device traffic or keyboard input. They are not required to build or run the app. These protocol notes describe observed behavior for the captured Studio and 40W S1 versions, rather than a complete or officially documented protocol.

## Deployment

The app is a static-assets Cloudflare Worker, `commons-hub-laser-labels`, configured in `wrangler.jsonc` and served at https://commons-hub-laser-labels.niemeyer-felix.workers.dev.

Workers Builds deploys every push to `main` (build command `pnpm run build`, deploy command `npx wrangler deploy`). To deploy by hand:

```sh
pnpm run deploy
```
