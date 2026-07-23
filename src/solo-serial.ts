/**
 * solo-serial.ts
 *
 * Minimal WebSerial client for the solo-serial protocol.
 *
 * Can be used standalone in any web page; just import this module and
 * instantiate SoloSerialDevice.  No runtime dependencies required.
 *
 * Protocol reference: https://github.com/solo-fsw/solo-serial
 * Python library   : https://github.com/solo-fsw/solo-serial-python
 *
 * ─── Protocol summary ─────────────────────────────────────────────────────────
 *   Baud rates:  74880  = command mode (always supported)
 *                115200 = data mode (optional, USB-CDC devices only)
 *
 *   TX (host → device):   "command arg1 arg2\n"
 *                         Use backtick-quoting for args with spaces: `my arg`
 *
 *   RX (device → host):   "-"         ACK  – command received
 *                         " text"     DATA – single-space prefix
 *                         "  text"    DEBUG – two-space prefix
 *                         "+ text"    EVENT – async notification
 *                         "0"         EXIT CODE (integer) – 0 = success
 *
 *   Built-in commands: ping · info · getCommands · setDebug · getState
 * ──────────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const BAUD_COMMAND = 74880;
export const BAUD_DATA    = 115200;

const ACK_LINE   = "-";
const EVENT_PFX  = "+";
const DEBUG_PFX  = "  "; // two spaces
const DATA_PFX   = " ";  // one space

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Category of a received line, after protocol parsing. */
export type LineCategory =
  | "ack"
  | "data"
  | "debug"
  | "event"
  | "exit-ok"   // exit code 0
  | "exit-err"  // exit code != 0
  | "other";    // unrecognised / garbage

export interface ParsedLine {
  category: LineCategory;
  payload:  string;   // content without its prefix
  raw:      string;   // original line text
}

/** Response collected from a single RPC call. */
export interface RpcResponse {
  command:  string;
  args:     string[];
  exitCode: number | null;
  data:     string[];   // payloads of DATA lines, in order
  debug:    string[];   // payloads of DEBUG lines, in order
  events:   string[];   // payloads of EVENT lines received during this RPC
  success:  boolean;    // exitCode === 0
}

/** Parsed device info JSON returned by the `info` command. */
export interface DeviceInfo {
  solo_serial_version?: string;
  solo_number?:         string;
  firmware_version?:    string;
  hardware_version?:    string;
  name?:                string;
  has_data_mode?:       boolean;
  [key: string]: unknown;
}

/** Parsed command entry returned by `getCommands`. */
export interface CommandEntry {
  name:        string;
  description: string;
  args:        ArgDef[]; // command arguments with type info
}

/** Parsed state returned by `getState`. */
export interface DeviceState {
  debug: boolean;
  mode:  "command" | "data";
}

/** A single entry in the communication console log. */
export interface ConsoleEntry {
  direction: "tx" | "rx";
  category:  LineCategory | "tx";
  text:      string;      // raw line text as sent/received
  timestamp: Date;
}

export type ConsoleListener    = (entry: ConsoleEntry)   => void;
export type EventListener      = (payload: string)       => void;
export type DisconnectListener = ()                      => void;

// ---------------------------------------------------------------------------
// Parsed call-description types (for UI form generation)
// ---------------------------------------------------------------------------

/** A single argument parsed from a command's callDescription. */
export interface ArgDef {
  name:     string;
  type:     string;      // "int" | "float" | "bool" | "string" | "json" | ""
  required: boolean;
  choices?: string[];    // present when type contains {...}
  min?:     number;      // present when type contains [min..max]
  max?:     number;
  unit?:    string;      // annotation after the range bracket
}

/** Result of parsing a callDescription. */
export interface ParsedUsage {
  commandName: string;
  args:        ArgDef[];
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

function parseLine(raw: string): ParsedLine {
  if (raw === ACK_LINE) {
    return { category: "ack", payload: "", raw };
  }
  if (raw.startsWith(EVENT_PFX)) {
    return { category: "event", payload: raw.slice(1).trimStart(), raw };
  }
  if (raw.startsWith(DEBUG_PFX)) {
    return { category: "debug", payload: raw.slice(2), raw };
  }
  if (raw.startsWith(DATA_PFX)) {
    return { category: "data", payload: raw.slice(1), raw };
  }
  // Check for integer exit code
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    const n = Number(trimmed);
    if (!Number.isNaN(n) && Number.isInteger(n)) {
      return { category: n === 0 ? "exit-ok" : "exit-err", payload: trimmed, raw };
    }
  }
  return { category: "other", payload: raw, raw };
}

function quoteArg(arg: string): string {
  return arg.includes(" ") ? "`" + arg + "`" : arg;
}

// ---------------------------------------------------------------------------
// SoloSerialDevice — main class
// ---------------------------------------------------------------------------

export class SoloSerialDevice {
  private _port:        SerialPort | null = null;
  private _portWriter:  WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _rawReader:   ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _readLoop:    Promise<void> | null = null;
  private _stopSignal   = false;
  private _enc          = new TextEncoder();
  private _currentBaudRate: number = BAUD_COMMAND;

  private _pending: {
    response: RpcResponse;
    resolve:  (r: RpcResponse) => void;
    reject:   (e: Error)       => void;
  } | null = null;

  private _consoleListeners:    ConsoleListener[]    = [];
  private _eventListeners:      EventListener[]      = [];
  private _disconnectListeners: DisconnectListener[] = [];

  // ---- Status ----------------------------------------------------------------

  get isConnected(): boolean {
    return this._port !== null;
  }

  get portInfo(): { comPort: string | null; vendorId: number | null; productId: number | null } {
    if (!this._port) return { comPort: null, vendorId: null, productId: null };
    try {
      const info = this._port.getInfo();
      return {
        comPort: (info as any).comPort || null,
        vendorId: (info as any).usbVendorId || null,
        productId: (info as any).usbProductId || null,
      };
    } catch {
      return { comPort: null, vendorId: null, productId: null };
    }
  }

  get currentBaudRate(): number {
    return this._currentBaudRate;
  }

  // ---- Listener registration -------------------------------------------------

  /**
   * Register a listener for every TX/RX console entry.
   * Returns an unsubscribe function.
   */
  onConsole(fn: ConsoleListener): () => void {
    this._consoleListeners.push(fn);
    return () => { this._consoleListeners = this._consoleListeners.filter(l => l !== fn); };
  }

  /**
   * Register a listener for async EVENT lines from the device.
   * Returns an unsubscribe function.
   */
  onEvent(fn: EventListener): () => void {
    this._eventListeners.push(fn);
    return () => { this._eventListeners = this._eventListeners.filter(l => l !== fn); };
  }

  /**
   * Register a listener called when the device disconnects (including unexpected drops).
   * Returns an unsubscribe function.
   */
  onDisconnect(fn: DisconnectListener): () => void {
    this._disconnectListeners.push(fn);
    return () => { this._disconnectListeners = this._disconnectListeners.filter(l => l !== fn); };
  }

  // ---- Connection ------------------------------------------------------------

  /**
   * Open a serial connection to a solo-serial device.
   * If `port` is omitted, the browser's port-picker dialog is shown.
   */
  async connect(port?: SerialPort): Promise<void> {
    if (this._port) await this.disconnect();

    this._port = port ?? await navigator.serial.requestPort();
    this._stopSignal = false;

    await this._port.open({ baudRate: BAUD_COMMAND });
    this._currentBaudRate = BAUD_COMMAND;
    this._portWriter = this._port.writable!.getWriter();
    this._readLoop   = this._runReadLoop();
  }

  /** Close the connection gracefully. */
  async disconnect(): Promise<void> {
    this._stopSignal = true;

    if (this._pending) {
      this._pending.reject(new Error("Disconnected"));
      this._pending = null;
    }

    try { await this._rawReader?.cancel(); }       catch { /* ignore */ }
    await this._readLoop?.catch(() => undefined);

    try { this._portWriter?.releaseLock(); }        catch { /* ignore */ }
    this._portWriter = null;

    try { await this._port?.close(); }              catch { /* ignore */ }
    this._port = null;

    this._disconnectListeners.forEach(l => l());
  }

  /**
   * Change the serial baud rate (used for mode switching).
   * Closes the port and reopens it at the new rate; the read loop restarts automatically.
   */
  async switchBaud(baudRate: number): Promise<void> {
    if (!this._port) throw new Error("Not connected");

    this._stopSignal = true;
    if (this._pending) {
      this._pending.reject(new Error("Mode switch"));
      this._pending = null;
    }

    try { await this._rawReader?.cancel(); }         catch { /* ignore */ }
    await this._readLoop?.catch(() => undefined);
    try { this._portWriter?.releaseLock(); }          catch { /* ignore */ }

    await this._port.close();
    await this._port.open({ baudRate });
    this._currentBaudRate = baudRate;
    // Give the Arduino time to detect the baud-rate change before any commands are sent.
    await new Promise<void>(resolve => setTimeout(resolve, 150));

    this._stopSignal  = false;
    this._portWriter  = this._port.writable!.getWriter();
    this._readLoop    = this._runReadLoop();
  }

  // ---- Command sending -------------------------------------------------------

  /**
   * Send a command and return a promise that resolves when the device sends its exit code.
   * Only one command can be in flight at a time.
   */
  sendCommand(command: string, ...args: string[]): Promise<RpcResponse> {
    if (!this._portWriter) return Promise.reject(new Error("Not connected"));
    if (this._pending)     return Promise.reject(new Error("A command is already in progress"));
    if (typeof command !== "string" || !command.trim()) {
      return Promise.reject(new Error(`Command name must be a non-empty string, got: ${typeof command}`));
    }

    const line = [command, ...args.map(quoteArg)].join(" ");
    const response: RpcResponse = {
      command, args, exitCode: null, data: [], debug: [], events: [], success: false,
    };

    return new Promise<RpcResponse>((resolve, reject) => {
      this._pending = { response, resolve, reject };
      this._emitConsole({ direction: "tx", category: "tx", text: line, timestamp: new Date() });
      this._portWriter!.write(this._enc.encode(line + "\n")).catch(err => {
        this._pending = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Like `sendCommand`, but rejects after `timeoutMs` if no exit code arrives.
   *
   * On timeout the pending-command slot is cleared so the port remains usable.
   * This is intentionally private; callers that need timed commands should use
   * `probeDeviceInfo` or a similar high-level helper.
   */
  private _sendCommandWithTimeout(
    command: string,
    timeoutMs: number,
    ...args: string[]
  ): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Only wipe _pending if it still belongs to this call.
        if (this._pending?.response.command === command) {
          this._pending = null;
        }
        reject(new Error(`Command "${command}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.sendCommand(command, ...args).then(
        result => { clearTimeout(timer); resolve(result); },
        err    => { clearTimeout(timer); reject(err); },
      );
    });
  }

  /**
   * Send raw bytes directly to the device (intended for data mode payloads).
   * Does not append a newline.
   */
  async sendRawBytes(bytes: Uint8Array): Promise<void> {
    if (!this._portWriter) throw new Error("Not connected");
    if (this._pending) throw new Error("A command is already in progress");
    if (bytes.length === 0) throw new Error("No bytes to send");

    const preview = Array.from(bytes)
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");

    this._emitConsole({
      direction: "tx",
      category: "tx",
      text: `[bytes ${bytes.length}] ${preview}`,
      timestamp: new Date(),
    });

    await this._portWriter.write(bytes);
  }

  // ---- Built-in command wrappers ---------------------------------------------

  ping():               Promise<RpcResponse> { return this.sendCommand("ping"); }
  info():               Promise<RpcResponse> { return this.sendCommand("info"); }
  getCommands():        Promise<RpcResponse> { return this.sendCommand("getCommands"); }
  setDebug(on: boolean): Promise<RpcResponse> { return this.sendCommand("setDebug", on ? "1" : "0"); }
  getState():           Promise<RpcResponse> { return this.sendCommand("getState"); }

  /**
   * Call a device method with any arguments.
   * Arguments are automatically converted to strings for transmission.
   * 
   * Example usage:
   *   const resp = await device.call('blink', 5);
   *   const resp = await device.call('setColor', 'red', 128, 255);
   * 
   * Returns the complete RPC response with exit code, data, debug, and event payloads.
   */
  call(method: string, ...args: any[]): Promise<RpcResponse> {
    return this.sendCommand(method, ...args.map(arg => String(arg)));
  }

  // ---- Parsed high-level helpers ---------------------------------------------

  /**
   * Send `info` and return the parsed device info JSON.
   *
   * Mirrors the Python `_probe_device_info` retry strategy so that boards like
   * the Arduino Uno (which reset via DTR on port-open and run a bootloader for
   * ~1-2 s before the sketch starts) are handled correctly:
   *
   *  1. Send `info` immediately; wait up to `startupWaitMs` (default 3 000 ms).
   *  2. If no exit code arrives in time the board is probably still booting.
   *     Clear the pending slot and resend `info`; wait up to `responseTimeoutMs`
   *     (default 2 000 ms) for the response.
   *  3. If the device still does not reply, throw a descriptive error.
   *
   * Fast boards (Leonardo, ESP32) respond before the first timeout expires, so
   * their behaviour is unchanged.
   */
  async probeDeviceInfo(
    startupWaitMs  = 3000,
    responseTimeoutMs = 2000,
  ): Promise<DeviceInfo> {
    let resp: RpcResponse;

    try {
      // First attempt — succeeds immediately for fast boards.
      resp = await this._sendCommandWithTimeout("info", startupWaitMs);
    } catch (firstErr) {
      if (!this._port) throw firstErr; // disconnected mid-probe
      // Board is likely still in the bootloader (e.g. Uno DTR reset).
      // The startup window has now elapsed; resend and wait for the sketch.
      try {
        resp = await this._sendCommandWithTimeout("info", responseTimeoutMs);
      } catch {
        throw new Error(
          `Device did not respond to the info command within ` +
          `${startupWaitMs + responseTimeoutMs} ms. ` +
          `Ensure the device is powered, running solo-serial firmware, and try again.`,
        );
      }
    }

    if (!resp.success || resp.data.length === 0) {
      throw new Error(`info command failed (exit code ${resp.exitCode})`);
    }
    return JSON.parse(resp.data[0]) as DeviceInfo;
  }

  /** Send `getCommands` and return the parsed command list. */
  async probeCommandList(): Promise<CommandEntry[]> {
    const resp = await this.getCommands();
    if (!resp.success) throw new Error(`getCommands failed (exit code ${resp.exitCode})`);
    return resp.data.map(parseCommandLine);
  }

  /**
   * Send `getState` and return the parsed device state.
   *
   * If `expectedMode` is provided and the returned mode differs, the call is
   * retried with exponential back-off (100 ms → 200 ms → 400 ms) to allow the
   * Arduino time to detect the baud-rate change — a communication timing concern.
   * Any protocol violation (malformed JSON, missing required fields, mode mismatch
   * after all retries) throws; the caller is responsible for surfacing the error.
   */
  async probeDeviceState(expectedMode?: "command" | "data"): Promise<DeviceState> {
    const backoff = [100, 200, 400]; // ms delays before retries 1, 2, 3

    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      const resp = await this.getState();
      if (!resp.success || resp.data.length === 0) {
        throw new Error(`getState failed (exit code ${resp.exitCode})`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(resp.data[0]);
      } catch {
        throw new Error(`getState returned invalid JSON: ${resp.data[0]}`);
      }
      if (
        typeof parsed !== "object" || parsed === null ||
        !("mode"  in parsed) ||
        !("debug" in parsed)
      ) {
        throw new Error(
          `getState response is missing required fields "mode" and/or "debug" ` +
          `(got: ${resp.data[0]})`
        );
      }
      const state = parsed as DeviceState;

      if (!expectedMode || state.mode === expectedMode) {
        if (attempt > 0) {
          console.warn(`[solo-serial] getState mode matched on attempt ${attempt + 1}.`);
        }
        return state;
      }

      if (attempt < backoff.length) {
        console.warn(
          `[solo-serial] getState returned "${state.mode}", expected "${expectedMode}". ` +
          `Retry ${attempt + 1}/${backoff.length} in ${backoff[attempt]} ms…`
        );
        await new Promise<void>(resolve => setTimeout(resolve, backoff[attempt]));
      }
    }

    throw new Error(
      `Device did not enter "${expectedMode}" mode after ${backoff.length} retries.`
    );
  }

  // ---- Internal: read loop ---------------------------------------------------

  private async _runReadLoop(): Promise<void> {
    if (!this._port?.readable) return;

    const reader = this._port.readable.getReader();
    this._rawReader = reader;

    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (!this._stopSignal) {
        const { value, done } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (line.length > 0) this._handleLine(line);
        }
      }
    } catch (err) {
      if (!this._stopSignal) {
        const e = err instanceof Error ? err : new Error(String(err));
        this._pending?.reject(e);
        this._pending = null;
        this._disconnectListeners.forEach(l => l());
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      this._rawReader = null;
    }
  }

  private _handleLine(raw: string): void {
    const parsed = parseLine(raw);
    this._emitConsole({ direction: "rx", category: parsed.category, text: raw, timestamp: new Date() });

    // Always surface events to listeners, even when an RPC is active.
    if (parsed.category === "event") {
      this._eventListeners.forEach(l => l(parsed.payload));
    }

    const rpc = this._pending;
    if (!rpc) return;

    switch (parsed.category) {
      case "data":  rpc.response.data.push(parsed.payload);   break;
      case "debug": rpc.response.debug.push(parsed.payload);  break;
      case "event": rpc.response.events.push(parsed.payload); break;
      case "exit-ok":
      case "exit-err": {
        const code = parseInt(parsed.payload, 10);
        rpc.response.exitCode = code;
        rpc.response.success  = parsed.category === "exit-ok";
        this._pending = null;
        rpc.resolve(rpc.response);
        break;
      }
    }
  }

  private _emitConsole(entry: ConsoleEntry): void {
    this._consoleListeners.forEach(l => l(entry));
  }
}

// ---------------------------------------------------------------------------
// Usage / call-description parser
// ---------------------------------------------------------------------------

/**
 * Parse a solo-serial callDescription string into structured argument definitions.
 *
 * Supported syntax (from solo-serial.h):
 *   Argument:              <name:type>
 *   Choice constraint:     <name:type{a|b|c}>
 *   Range constraint:      <name:type[min..max]>
 *   Range + unit:          <name:type[min..max]unit>
 *
 * Informal (non-standard) descriptions are gracefully handled — unrecognised
 * inner text is exposed as the arg name with an empty type.
 */
export function parseUsage(usage: string): ParsedUsage {
  const tokens      = usage.trim().split(/\s+/);
  const commandName = tokens[0] ?? "";
  const rest        = tokens.slice(1).join(" ");
  const args: ArgDef[] = [];

  // Match <inner>
  const re = /<([^>]+)>/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(rest)) !== null) {
    const inner    = m[1];

    const colon   = inner.indexOf(":");
    const name    = colon === -1 ? inner       : inner.slice(0, colon);
    const typeStr = colon === -1 ? ""          : inner.slice(colon + 1);

    const arg: ArgDef = { name, type: typeStr, required: true };

    // Choices:  type{a|b|c}
    const cm = typeStr.match(/^([^{[]*)\{([^}]+)\}/);
    if (cm) { arg.type = cm[1]; arg.choices = cm[2].split("|"); }

    // Range:  type[min..max]unit?
    const rm = typeStr.match(/^([^[]*)\[(-?[\d.]+)\.\.(-?[\d.]+)\](\w+)?/);
    if (rm) {
      arg.type = rm[1];
      arg.min  = parseFloat(rm[2]);
      arg.max  = parseFloat(rm[3]);
      if (rm[4]) arg.unit = rm[4];
    }

    args.push(arg);
  }

  return { commandName, args };
}

// ---------------------------------------------------------------------------
// Internal helper: parse a getCommands data line (NDJSON format)
// ---------------------------------------------------------------------------

/** Parse one JSON object from `getCommands` output into a CommandEntry. */
export function parseCommandLine(line: string): CommandEntry {
  try {
    const obj = JSON.parse(line) as {
      name?: string;
      desc?: string;
      args?: Array<{
        name?: string;
        type?: string;
        opt?: boolean;
        min?: number;
        max?: number;
        smin?: number;
        smax?: number;
        unit?: string;
        choices?: string[];
      }>;
    };

    const name = obj.name ?? "";
    const description = obj.desc ?? "";
    const args: ArgDef[] = [];

    // Validate command name: must be a single word (no spaces, special chars like ->)
    if (!name || typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid command name: "${name}". Command names must be single words (alphanumeric + underscore).`);
    }

    if (Array.isArray(obj.args)) {
      for (const arg of obj.args) {
        const argDef: ArgDef = {
          name: arg.name ?? "",
          type: arg.type ?? "",
          required: !arg.opt,
        };

        if (arg.choices) {
          argDef.choices = arg.choices;
        }
        if (arg.type === "string") {
          // For string args, store length constraints as min/max
          if (arg.smin !== undefined) argDef.min = arg.smin;
          if (arg.smax !== undefined) argDef.max = arg.smax;
        } else {
          // For numeric args (int, float), use min/max directly
          if (arg.min !== undefined) argDef.min = arg.min;
          if (arg.max !== undefined) argDef.max = arg.max;
        }
        if (arg.unit) {
          argDef.unit = arg.unit;
        }

        args.push(argDef);
      }
    }

    return { name, description, args };
  } catch (err) {
    // Re-throw parsing errors with context
    throw new Error(`Failed to parse command line: ${errMsg(err)}. Line: "${line}"`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
