# xTool S1 from Linux: findings & test plan

As of 2026-10-10

There is no official Linux software for the xTool S1. The fastest way to a test print from Linux is the free LightBurn trial over USB; the open-source way is the S1's undocumented local network API, fed with G-code captured from a real job.

## Routes

Only two routes run natively on Linux today: LightBurn (closed, paid, free trial) over USB, and the reverse-engineered network API. Everything official needs Windows, macOS or a frozen Android app.

| Route | Runs on Linux | Open source | S1 status | Effort |
| --- | --- | --- | --- | --- |
| [xTool Studio / XCS desktop](https://support.xtool.com/article/2810) | No (Windows 10+, macOS) | No | Officially supported | Low |
| [Legacy XCS Android app 2.2.1](https://support.xtool.com/article/3702) (APK) | No, but avoids Windows | No | Supports the S1, but frozen: no more updates. The new mobile app does not list the S1. | Low |
| [LightBurn](https://docs.lightburnsoftware.com/2.1/Troubleshooting/DeviceSpecificTroubleshooting/) over USB | Yes, native | No (paid, free trial) | Native S1 support since 1.7 (XTOOL protocol), USB only. LightBurn warns that June 2026 xTool firmware broke support on some machines. | Low |
| Local network API (HTTP :8080, WebSocket :8081) | Yes | Yes, our own script | Reverse-engineered, no authentication. [ha-xtool](https://github.com/thecodingdad/ha-xtool) was built and tested on an S1. | Medium |
| USB serial G-code (GRBL-like) | Yes | Yes | Unverified on the S1. LightBurn's GRBL compatibility before 1.7 suggests it mostly works. | Medium |
| [xTool-Connect](https://github.com/1RandomDev/xTool-Connect) Wi-Fi bridge for LightBurn | Yes | Yes | Written for the D1 Pro, not the S1; untouched for about 1.5 years | Skip |

## Other findings

- **The machine:** the S1 launched in October 2023 and is still sold. xTool is active (CES 2026, new machines at IFA 2026), but it is moving to cloud and AI software, not open protocols.
- **Network:** the S1 only joins **2.4 GHz** Wi-Fi.
- **SVG import:** xTool Studio and XCS make one layer per **stroke colour**. Cut, engrave and power are still set by hand per layer on every import; nothing is remembered per colour.
- **Text** in an SVG must already be outlines. Imported size depends on an **import DPI setting**, so check the size once.
- **Our label app** (`lable-printer`, Vue + Vite) exports the common laser convention: outline and drill holes as a red `#FF0000` hairline (cut), text as black-filled outlines with a black stroke (engrave), size in mm. LightBurn also turns these colours into layers, so the same file works there.

## Decoded USB protocol (2026-10-11)

Recorded with USBPcap while xTool Studio 1.9.11 cut two labels (`reference-files/`). Details checked against Studio's own JavaScript (`F3F4Uploader` in `app.asar`). The label app now speaks this protocol over Web Serial; see `src/s1.ts` and `src/gcode.ts`.

- **USB:** CDC serial device `28e9:018a` (GigaDevice). No encryption.
- **Commands:** text lines, each sent as `<command>\n\n`. The S1 answers an M-code with a line starting with the same code (`M100` → `M100 "xTool S1"`). G-code moves get no answer. The S1 also pushes lines on its own, mainly `M222 S<state>`.
- **States (`M222`):** 3 ready, 13 job uploaded and waiting for the machine's button, 14 running, 19 done, 7 lid open, 9 flame.
- **Job upload:** `M362`, `M321`, `M25`, `M2240`, `M810 "<uuid>"`, then the file `tmp.gcode` in binary frames, then `M323 S1`. The job starts when someone presses the button on the S1.
- **Frames:** `F3 · header sum · length u16 LE · payload · payload sum · F4`. Both sums are byte sums & 0xFF; the header sum covers `F3` and the length. Payload: `01 01 5E · cmd · data length u16 LE · data`.
  - cmd `01` announces the file: `00 · size u32 LE · checksum (4 bytes) · name`. The checksum XORs the file onto itself in 4-byte steps: byte *i* goes into checksum byte *i* mod 4.
  - cmd `02` carries up to 16 KB: `offset u32 LE · bytes`.
  - The S1 acknowledges every frame with cmd `F0`. Frame byte 10 = 1 means error.
- **G-code:** `S` is 0–1000, `F` is in mm/min. Machine X/Y = SVG millimetres + the label's position, no flip. Work area 498 × 330 for the 10/20 W module. Blocks: bitmap (`M4`, rows 0.1 mm apart, laser-off run-up v²/(2·3200) at both ends), vector engrave (`M4`), cut (`M3`, air assist `M15 S4`). `G0Z52.541` is the focus height the S1 measured on 3 mm plywood.
- **Red cross:** `M1109` returns its offset from the laser for the lowest and highest head position. `G0 X… Y… F9600` moves the head.

## Test plan for the superuser

Go for LightBurn over USB first: it is the shortest way to a real cut from Linux. Use the test to collect G-code, which opens the open-source route. Allow about 2 hours.

**A. Look at the machine (10 min, changes nothing)**

1. Note the S1's firmware version (shown in XCS/xTool Studio device info if anyone has it open). **Do not update the firmware** during this test.
2. Connect the S1 to the Linux machine by USB. Run `lsusb` and `sudo dmesg | tail`; expect a serial device such as `/dev/ttyACM0` or `/dev/ttyUSB0`.
3. Make sure your user may open the port: group `uucp` on Arch/Manjaro, `dialout` on Debian/Ubuntu (`sudo usermod -aG <group> $USER`, then log in again).
4. Optional: find the S1's IP in the router and run `curl http://<ip>:8080/progress`. Any answer means the network API is reachable. That endpoint is documented for the D1 Pro; check [ha-xtool](https://github.com/thecodingdad/ha-xtool)'s S1 code for the exact paths.

**B. First test print with LightBurn (about 1 hour)**

1. Download the LightBurn Linux build from lightburnsoftware.com and start the free trial.
2. Add the laser following [xTool's LightBurn guide for the S1](https://support.xtool.com/article/1036), then open the device settings and set the protocol to **XTOOL** ([forum walkthrough](https://forum.lightburnsoftware.com/t/setting-up-xtool-s1-with-new-xtool-device-type-in-lb-1-7-and-beyond/135463)).
3. In the label app, make a small label (one word, 2 side holes) and download the SVG.
4. Import it into LightBurn: it should create a red layer and a black layer. Red = Line (cut), black = Fill (engrave). Put the black layer first. Check that the size matches the size the app shows.
5. Put scrap wood in, focus, run **Frame**, then run the job with conservative settings (low power for the engraving; increase cut passes step by step rather than power).
6. Write down what worked per wood type: power, speed and passes for the engrave and the cut.

**C. Collect G-code for the open-source route (30 min)**

1. If LightBurn offers "Save GCode" for this device, save the test job. If not, run the same label once from the legacy XCS app or xTool Studio and copy the G-code from the S1's SD card ([xTool guide](https://support.xtool.com/article/1104)).
2. Hand the file to whoever builds the app. It shows the S1's exact commands for laser mode, air assist and focus, which our own Linux sender would need.

**If LightBurn will not connect:** check the firmware version against the [LightBurn device notes](https://docs.lightburnsoftware.com/2.1/Troubleshooting/DeviceSpecificTroubleshooting/). Fall back to the legacy Android app over Wi-Fi to run step B, then do step C.

## Safety and caveats

- Stay at the machine for the whole test, lid closed, extraction running, with a fire blanket or extinguisher within reach. The lid interlock is in the S1 firmware and works whatever software sends the job.
- **Do not update the S1 firmware** once a route works. Updates have already broken LightBurn, and the network API is undocumented.
- The network API has **no authentication**: anyone on the same network can start a job. Keep the S1 on a separate Wi-Fi or VLAN, never reachable from outside the house.
- Every line about the network API and USB G-code comes from community reverse engineering, mostly tested on other xTool models. Expect to adjust it on the S1.

## Sources

- [xTool: Legacy mobile app download (S1 support, APK)](https://support.xtool.com/article/3702)
- [xTool: Connect and set up the S1 with xTool Studio](https://support.xtool.com/article/2810)
- [xTool: Operate the S1 with XCS on a phone (Wi-Fi, 2.4 GHz)](https://support.xtool.com/article/1602)
- [xTool: Operate the S1 with LightBurn](https://support.xtool.com/article/1036)
- [xTool: Layer and object list (layers by stroke colour)](https://support.xtool.com/article/2532)
- [xTool: Import and parse vectors (SVG DPI)](https://support.xtool.com/article/2520)
- [xTool: FAQs on importing images (text to paths)](https://support.xtool.com/article/544)
- [xTool: Export G-code from the SD card](https://support.xtool.com/article/1104)
- [LightBurn: Device-specific troubleshooting](https://docs.lightburnsoftware.com/2.1/Troubleshooting/DeviceSpecificTroubleshooting/)
- [LightBurn forum: Setting up the S1 with the xTool device type](https://forum.lightburnsoftware.com/t/setting-up-xtool-s1-with-new-xtool-device-type-in-lb-1-7-and-beyond/135463)
- [ha-xtool (Home Assistant integration, tested on an S1)](https://github.com/thecodingdad/ha-xtool)
- [xTool-Connect protocol notes](https://github.com/1RandomDev/xTool-Connect/blob/master/XTOOL_PROTOCOL.md)
- [xTool community: S1 protocol thread](https://support.xtool.com/community-support/detail/3828)
