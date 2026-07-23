/**
 * connect.ts — Convenience connect helper for solo-serial devices.
 *
 * Provides auto-connect (no picker if a paired port is found) and
 * a one-call `connect()` function that probes device info/state after opening.
 */

import { SoloSerialDevice } from '../solo-serial';
import type { DeviceInfo, DeviceState } from '../solo-serial';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  /**
   * Filters passed to `navigator.serial.requestPort()` and used to match
   * already-paired ports for auto-connect.
   *
   * @example [{ usbVendorId: 0x2341 }]  // Arduino / Genuino devices
   */
  filters?: SerialPortFilter[];

  /**
   * Try to auto-connect to a previously paired port that matches the filters
   * before showing the browser's port-picker dialog.
   *
   * - If exactly one matching port is found it is used without showing the picker.
   * - If zero or more than one matching port is found the picker is shown.
   *
   * Default: `true`
   */
  autoConnect?: boolean;

  /**
   * Force the browser port-picker dialog even if auto-connect would succeed.
   * Default: `false`
   */
  forcePrompt?: boolean;
}

export interface ConnectedDevice {
  device: SoloSerialDevice;
  info:   DeviceInfo;
  state:  DeviceState;
}

// ---------------------------------------------------------------------------
// resolveAutoConnectPort — shared helper used by connect() and createWidget()
// ---------------------------------------------------------------------------

/**
 * Inspect the browser's list of already-paired ports and return the single
 * port that matches the optional filters.
 *
 * Returns `undefined` when:
 *  - no ports are paired yet
 *  - zero or more than one port matches the filters
 *  - the browser raises an error (e.g. permission denied)
 *
 * Calling this does **not** require a user gesture.
 */
export async function resolveAutoConnectPort(
  filters?: SerialPortFilter[],
): Promise<SerialPort | undefined> {
  let ports: SerialPort[];
  try {
    ports = await navigator.serial.getPorts();
  } catch {
    return undefined;
  }

  if (ports.length === 0) return undefined;

  if (!filters || filters.length === 0) {
    // No filter — only auto-connect when exactly one port is paired.
    return ports.length === 1 ? ports[0] : undefined;
  }

  const matching = ports.filter(p => {
    const info = p.getInfo();
    return filters.some(
      f =>
        (!f.usbVendorId  || info.usbVendorId  === f.usbVendorId) &&
        (!f.usbProductId || info.usbProductId === f.usbProductId),
    );
  });

  return matching.length === 1 ? matching[0] : undefined;
}

// ---------------------------------------------------------------------------
// connect — one-call convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Open a connection to a solo-serial device and return the device together
 * with the probed device info and state.
 *
 * This is the recommended entry point for simple use-cases.  For more control
 * (custom listeners, data-mode, etc.) create a `SoloSerialDevice` directly.
 *
 * ⚠ Must be called from within a user-gesture handler (button click, etc.)
 *   because the browser may need to show the port-picker dialog.
 *
 * @example
 * btn.addEventListener('click', async () => {
 *   const { device, info } = await SoloSerial.connect({
 *     filters: [{ usbVendorId: 0x2341 }],
 *   });
 *   device.onDisconnect(() => console.log('disconnected'));
 *   await device.sendCommand('ping');
 * });
 */
export async function connect(options?: ConnectOptions): Promise<ConnectedDevice> {
  if (!('serial' in navigator)) {
    throw new Error(
      'Web Serial is not supported in this browser. ' +
      'Use Chrome, Edge, or Opera on desktop and serve the page over HTTPS or localhost.',
    );
  }

  const device       = new SoloSerialDevice();
  const autoConnect  = options?.autoConnect  ?? true;
  const forcePrompt  = options?.forcePrompt  ?? false;

  // ── Resolve port ───────────────────────────────────────────────────────────
  let port: SerialPort | undefined;

  if (autoConnect && !forcePrompt) {
    port = await resolveAutoConnectPort(options?.filters);
  }

  if (port) {
    await device.connect(port);
  } else {
    const requestOptions: SerialPortRequestOptions = {};
    if (options?.filters?.length) requestOptions.filters = options.filters;
    const picked = await navigator.serial.requestPort(requestOptions);
    await device.connect(picked);
  }

  // ── Probe device ───────────────────────────────────────────────────────────
  const info  = await device.probeDeviceInfo();
  const state = await device.probeDeviceState();

  return { device, info, state };
}
