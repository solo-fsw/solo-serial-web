/**
 * widget.ts — self-contained connect/status widget for solo-serial devices.
 *
 * Injects its own scoped CSS into `<head>` (once per page) so it works in
 * any HTML context without extra stylesheets.
 *
 * @example
 * const { device } = SoloSerial.createWidget(document.getElementById('panel'), {
 *   filters: [{ usbVendorId: 0x2341 }],
 *   onConnect(device, info) {
 *     device.sendCommand('setLabel', 'my-experiment');
 *   },
 * });
 */

import { SoloSerialDevice } from '../solo-serial';
import type { DeviceInfo, DeviceState } from '../solo-serial';
import { resolveAutoConnectPort } from './connect';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WidgetOptions {
  /** CSS width of the widget container. Default: `'240px'` */
  width?: string;

  /**
   * Filters passed to `navigator.serial.requestPort()` and used when
   * searching for previously-paired ports to auto-connect.
   *
   * @example [{ usbVendorId: 0x2341 }]
   */
  filters?: SerialPortFilter[];

  /**
   * Attempt to auto-connect to a previously paired matching port when the
   * Connect button is clicked (no browser picker shown if found).
   * Default: `true`
   */
  autoConnect?: boolean;

  /**
   * Automatically try to connect on widget creation without waiting for a
   * button click. Works only when `autoConnect` is `true` **and** a
   * previously paired port is available (no user gesture required for
   * `getPorts()`).
   * Default: `true`
   */
  autoConnectOnLoad?: boolean;

  /** Called after a successful connection, before the UI updates. */
  onConnect?: (device: SoloSerialDevice, info: DeviceInfo, state: DeviceState) => void;

  /** Called when the device disconnects (user action or unexpected drop). */
  onDisconnect?: () => void;

  /** Called when a connection or probe attempt fails. */
  onError?: (err: Error) => void;
}

export interface WidgetHandle {
  /** The underlying `SoloSerialDevice` managed by this widget. */
  readonly device: SoloSerialDevice;
  /** Disconnect (if connected), remove the widget from the DOM, and clean up. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// CSS injection (once per page, scoped to .ss-widget)
// ---------------------------------------------------------------------------

const STYLE_ID = 'solo-serial-widget-style';

function injectWidgetStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ss-widget {
      display: inline-grid;
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1e293b;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      background: #ffffff;
      overflow: hidden;
      grid-template-rows: auto 1fr;
    }
    .ss-widget *, .ss-widget *::before, .ss-widget *::after {
      box-sizing: border-box;
    }
    /* Header row */
    .ss-widget-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
    }
    /* Status dot */
    .ss-widget-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #94a3b8;
      flex-shrink: 0;
      transition: background 0.2s;
    }
    .ss-widget-dot[data-state="connecting"] {
      background: #f59e0b;
      animation: ss-widget-pulse 1s ease-in-out infinite;
    }
    .ss-widget-dot[data-state="connected"] { background: #10b981; }
    @keyframes ss-widget-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
    /* Status label */
    .ss-widget-status {
      flex: 1;
      color: #475569;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Connect / Disconnect button */
    .ss-widget-btn {
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      background: #ffffff;
      color: #1e293b;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ss-widget-btn:hover:not(:disabled) {
      background: #f1f5f9;
      border-color: #94a3b8;
    }
    .ss-widget-btn:disabled { opacity: 0.5; cursor: default; }
    .ss-widget-btn-primary {
      background: #2563eb;
      border-color: #2563eb;
      color: #ffffff;
    }
    .ss-widget-btn-primary:hover:not(:disabled) {
      background: #1d4ed8;
      border-color: #1d4ed8;
    }
    /* Info grid (shown when connected) */
    .ss-widget-info {
      padding: 10px 12px;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 3px 10px;
      align-content: start;
    }
    .ss-widget-info-label {
      color: #64748b;
      font-size: 11px;
      white-space: nowrap;
    }
    .ss-widget-info-value {
      font-size: 11px;
      word-break: break-all;
    }
    /* Placeholder / error text */
    .ss-widget-placeholder {
      padding: 10px 12px;
      color: #94a3b8;
      font-size: 12px;
      font-style: italic;
    }
    .ss-widget-placeholder[data-error="true"] {
      color: #dc2626;
      font-style: normal;
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Internal probe helper (with retry for Leonardo-style DTR resets)
// ---------------------------------------------------------------------------

async function probeWithRetry(
  device: SoloSerialDevice,
  maxAttempts = 3,
  delayMs     = 1500,
): Promise<{ info: DeviceInfo; state: DeviceState }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const info  = await device.probeDeviceInfo();
      const state = await device.probeDeviceState();
      return { info, state };
    } catch (err) {
      lastErr = err;
      if (!device.isConnected) throw err; // port dropped — stop retrying
      if (attempt < maxAttempts) {
        await new Promise<void>(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// createWidget
// ---------------------------------------------------------------------------

/**
 * Create a self-contained connect/status widget and append it to `parent`.
 *
 * The widget handles the full connect → probe → display flow.  The returned
 * `device` instance can be used to send commands, listen for events, etc.
 *
 * @param parent  DOM element that will contain the widget.
 * @param options Configuration options.
 * @returns       A handle with the managed device and a `destroy()` method.
 */
export function createWidget(
  parent:  HTMLElement,
  options?: WidgetOptions,
): WidgetHandle {
  injectWidgetStyles();

  // Guard: Web Serial availability
  const hasSerial = 'serial' in navigator;

  const device = new SoloSerialDevice();
  const width  = options?.width ?? '240px';

  // ── DOM scaffold ───────────────────────────────────────────────────────────

  const container = document.createElement('div');
  container.className = 'ss-widget';
  container.style.width = width;

  // Header
  const header = document.createElement('div');
  header.className = 'ss-widget-header';

  const dot = document.createElement('span');
  dot.className = 'ss-widget-dot';
  dot.dataset.state = 'disconnected';

  const statusText = document.createElement('span');
  statusText.className = 'ss-widget-status';
  statusText.textContent = 'Disconnected';

  const btn = document.createElement('button');
  btn.className = 'ss-widget-btn ss-widget-btn-primary';
  btn.type = 'button';
  btn.textContent = 'Connect';

  header.append(dot, statusText, btn);

  // Body / info area
  const body = document.createElement('div');

  const placeholder = document.createElement('div');
  placeholder.className = 'ss-widget-placeholder';

  container.append(header, body);
  parent.appendChild(container);

  // ── Unsupported browser ────────────────────────────────────────────────────

  if (!hasSerial) {
    placeholder.textContent =
      'Web Serial is not available. Use Chrome, Edge, or Opera on desktop ' +
      'and serve the page over HTTPS or localhost.';
    placeholder.dataset.error = 'true';
    body.appendChild(placeholder);
    btn.disabled = true;
    return { device, destroy };
  }

  showPlaceholder('Click Connect to connect to a device.');

  // ── UI state helpers ───────────────────────────────────────────────────────

  function showPlaceholder(msg: string, isError = false): void {
    body.innerHTML = '';
    placeholder.textContent = msg;
    placeholder.dataset.error = isError ? 'true' : 'false';
    body.appendChild(placeholder);
  }

  function setConnecting(): void {
    dot.dataset.state = 'connecting';
    statusText.textContent = 'Connecting…';
    btn.disabled = true;
  }

  function setConnected(info: DeviceInfo, state: DeviceState): void {
    dot.dataset.state = 'connected';
    statusText.textContent = 'Connected';
    btn.disabled = false;
    btn.textContent = 'Disconnect';
    btn.className = 'ss-widget-btn';
    renderInfo(info, state);
  }

  function setDisconnected(): void {
    dot.dataset.state = 'disconnected';
    statusText.textContent = 'Disconnected';
    btn.disabled = false;
    btn.textContent = 'Connect';
    btn.className = 'ss-widget-btn ss-widget-btn-primary';
    showPlaceholder('Click Connect to connect to a device.');
  }

  function renderInfo(info: DeviceInfo, state: DeviceState): void {
    body.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'ss-widget-info';

    const rows: [string, string][] = [
      ['Name',     String(info.name                  ?? '—')],
      ['Solo #',   String(info.solo_number           ?? '—')],
      ['Firmware', String(info.firmware_version      ?? '—')],
      ['Hardware', String(info.hardware_version      ?? '—')],
      ['Protocol', String(info.solo_serial_version   ?? '—')],
      ['Mode',     state.mode],
    ];

    const known = new Set([
      'name', 'solo_number', 'firmware_version', 'hardware_version',
      'solo_serial_version', 'has_data_mode',
    ]);
    for (const [k, v] of Object.entries(info)) {
      if (!known.has(k)) {
        rows.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
      }
    }

    for (const [label, value] of rows) {
      const lbl = document.createElement('span');
      lbl.className   = 'ss-widget-info-label';
      lbl.textContent = label;

      const val = document.createElement('span');
      val.className   = 'ss-widget-info-value';
      val.textContent = value;

      grid.append(lbl, val);
    }
    body.appendChild(grid);
  }

  // ── Connect / disconnect logic ─────────────────────────────────────────────

  let busy = false;

  async function doConnect(forcePrompt = false): Promise<void> {
    if (busy) return;
    busy = true;
    setConnecting();

    try {
      let port: SerialPort | undefined;

      if ((options?.autoConnect ?? true) && !forcePrompt) {
        port = await resolveAutoConnectPort(options?.filters);
      }

      if (port) {
        await device.connect(port);
      } else {
        const requestOpts: SerialPortRequestOptions = {};
        if (options?.filters?.length) requestOpts.filters = options.filters;
        const picked = await navigator.serial.requestPort(requestOpts);
        await device.connect(picked);
      }

      const { info, state } = await probeWithRetry(device);
      setConnected(info, state);
      options?.onConnect?.(device, info, state);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // NotFoundError = user closed the picker without selecting a port
      if ((err as DOMException)?.name === 'NotFoundError') {
        setDisconnected();
      } else {
        showPlaceholder(error.message || 'Connection failed.', true);
        dot.dataset.state = 'disconnected';
        statusText.textContent = 'Error';
        btn.disabled = false;
        btn.textContent = 'Retry';
        btn.className = 'ss-widget-btn ss-widget-btn-primary';
        options?.onError?.(error);
      }
    } finally {
      busy = false;
    }
  }

  async function doDisconnect(): Promise<void> {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      await device.disconnect();
    } finally {
      busy = false;
    }
  }

  btn.addEventListener('click', () => {
    if (device.isConnected) {
      void doDisconnect();
    } else {
      void doConnect(false);
    }
  });

  device.onDisconnect(() => {
    setDisconnected();
    options?.onDisconnect?.();
  });

  // ── Auto-connect on load ───────────────────────────────────────────────────

  if ((options?.autoConnect ?? true) && (options?.autoConnectOnLoad ?? true)) {
    // Non-blocking; does not require a user gesture because it only calls
    // getPorts() (which is allowed without gesture) and connects only when
    // exactly one matching port is already paired.
    void resolveAutoConnectPort(options?.filters).then(port => {
      if (port && !busy && !device.isConnected) {
        void doConnect(false);
      }
    });
  }

  // ── destroy ────────────────────────────────────────────────────────────────

  function destroy(): void {
    if (device.isConnected) void device.disconnect();
    container.remove();
  }

  return { device, destroy };
}
