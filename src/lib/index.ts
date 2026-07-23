/**
 * solo-serial.js — browser library for communicating with solo-serial devices
 * via the Web Serial API.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *   Load from GitHub Pages (replace v0 with the major version you target):
 *
 *     <script src="https://solo-fsw.github.io/solo-serial/lib/v0/solo-serial.js"></script>
 *
 *   The script exposes a global `SoloSerial` object:
 *
 *     // Widget — easiest way to let users connect:
 *     const { device } = SoloSerial.createWidget(
 *       document.getElementById('my-panel'),
 *       { filters: [{ usbVendorId: 0x2341 }] }
 *     );
 *
 *     // Programmatic connect (must be called from a user-gesture handler):
 *     const { device, info } = await SoloSerial.connect({
 *       filters: [{ usbVendorId: 0x2341 }],
 *     });
 *     await device.sendCommand('ping');
 *
 * ─── Protocol ─────────────────────────────────────────────────────────────────
 *   https://github.com/solo-fsw/solo-serial
 *
 * ─── Version ──────────────────────────────────────────────────────────────────
 */

// ── Core protocol class & constants ──────────────────────────────────────────
export {
  SoloSerialDevice,
  BAUD_COMMAND,
  BAUD_DATA,
  parseCommandLine,
} from '../solo-serial';

export type {
  LineCategory,
  ParsedLine,
  RpcResponse,
  DeviceInfo,
  CommandEntry,
  DeviceState,
  ConsoleEntry,
  ConsoleListener,
  EventListener,
  DisconnectListener,
  ArgDef,
  ParsedUsage,
} from '../solo-serial';

// ── Widget ────────────────────────────────────────────────────────────────────
export { createWidget } from './widget';
export type { WidgetOptions, WidgetHandle } from './widget';

// ── Convenience connect + auto-connect helper ─────────────────────────────────
export { connect, resolveAutoConnectPort } from './connect';
export type { ConnectOptions, ConnectedDevice } from './connect';

// ── Version (injected at build time) ─────────────────────────────────────────
declare const __LIB_VERSION__: string;
/** Semver string of the loaded library build, e.g. `"0.1.0"`. */
export const version: string = __LIB_VERSION__;
