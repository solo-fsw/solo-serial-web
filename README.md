# Solo Serial — Web Toolkit

Browser-based tools for communicating with [solo-serial-arduino](https://github.com/solo-fsw/solo-serial-arduino/) devices over USB.

This toolkit provides a **JavaScript library** to add device support to any web page, plus built-in tools for development and testing.

## What's included

- **Core library** — A lightweight JavaScript module for talking to solo-serial devices. Embed it in any web page.
- **Console** — An interactive debugging tool to inspect device communication in real time. Handy for testing firmware.
- **Demo** — Example code showing how to use the library in your own projects.

**No drivers, no server, no installation required** — communicates directly via USB using the browser's Web Serial API.

---

## Using the library

The easiest way to add solo-serial support to your web page is to load the library and use the connection widget:

```html
<div id="solo-panel"></div>

<script src="https://solo-fsw.github.io/solo-serial-web/lib/v0.1/solo-serial.js"></script>
<script>
  const { device } = SoloSerial.createWidget(
    document.getElementById('solo-panel'),
    { onConnect: () => console.log('Device connected!') }
  );
</script>
```

That's it — the widget handles connecting, shows device info, and lets you call device commands.

For more control, see [full API documentation](#library-api-reference) below.

---

## Console tool

Want to debug your device offline? Run the **Console** — an interactive web app for connecting to solo-serial devices and logging all communication.

**To run locally:**

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` and plug in your device.

The console shows:
- **Device info** (name, version, firmware details)
- **Command panel** — auto-generated form for calling any device command
- **Live log** — color-coded communication trace (TX/RX)

---

## Demo

See [public/demo.html](public/demo.html) for working code examples. After building, it's served at:

```
https://solo-fsw.github.io/solo-serial-web/demo.html
```

---

## Browser support

- **Chrome 89+, Edge 89+, Opera 75+** (desktop only)
- **Firefox and Safari** — not supported (no Web Serial API)
- Must be served over **HTTPS** or **localhost** (API security restriction)

---

## For developers

### Quick start (local development)

**Requirements:** [Node.js](https://nodejs.org/) 18 or later.

```bash
npm install
npm run dev
```

Open the URL printed by Vite (usually `http://localhost:5173`). Plug in a device and click **Connect**.

---

### Library API reference

#### Widget function

```ts
SoloSerial.createWidget(parent: HTMLElement, options?: WidgetOptions): WidgetHandle

interface WidgetOptions {
  filters?: SerialPortFilter[];      // Filter by vendor/product ID
  onConnect?: () => void;             // Callback when connected
  onDisconnect?: () => void;          // Callback when disconnected
  onError?: (error: Error) => void;   // Callback on errors
}

interface WidgetHandle {
  device: SoloSerialDevice;           // Underlying device object
  destroy(): void;                    // Clean up the widget
}
```

#### Connect function

```ts
SoloSerial.connect(options?: ConnectOptions): Promise<ConnectedDevice>

interface ConnectOptions {
  filters?: SerialPortFilter[];
}

interface ConnectedDevice {
  device: SoloSerialDevice;      // For manual commands
  info: DeviceInfo;              // Device info from info command
  state: DeviceState;            // Device state (debug, mode)
}
```

#### Core device class

```ts
class SoloSerialDevice {
  // Connect/disconnect
  connect(port?: SerialPort): Promise<void>;
  disconnect(): Promise<void>;
  get isConnected(): boolean;

  // Send commands
  sendCommand(...args: string[]): Promise<RpcResponse>;
  call(method: string, ...args: any[]): Promise<RpcResponse>;  // Convenience wrapper
  sendRawBytes(bytes: Uint8Array): Promise<void>;

  // Built-in commands
  ping(): Promise<RpcResponse>;
  info(): Promise<RpcResponse>;
  getCommands(): Promise<RpcResponse>;
  setDebug(enabled: boolean): Promise<RpcResponse>;
  getState(): Promise<RpcResponse>;

  // Parsed high-level helpers
  probeDeviceInfo(): Promise<DeviceInfo>;
  probeCommandList(): Promise<CommandEntry[]>;
  probeDeviceState(expectedMode?: string): Promise<DeviceState>;

  // Baud rate / mode switching
  switchBaud(rate: number): Promise<void>;

  // Listeners
  onConsole(fn: (entry: ConsoleEntry) => void): void;
  onEvent(fn: (payload: any) => void): void;
  onDisconnect(fn: () => void): void;
}
```

#### Utility functions

```ts
// Resolve a port without showing the picker
SoloSerial.resolveAutoConnectPort(filters?: SerialPortFilter[]): Promise<SerialPort | undefined>

// Parse command signature strings
SoloSerial.parseUsage(usage: string): ArgDef[]
SoloSerial.parseCommandLine(line: string): CommandEntry

// Constants
SoloSerial.BAUD_COMMAND  // = 74880
SoloSerial.BAUD_DATA     // = 115200
```

#### Types

```ts
type RpcResponse = {
  exitCode: number;
  data: string[];
  debug: string[];
  events: string[];
  success: boolean;
};

type DeviceInfo = {
  [key: string]: any;  // Depends on device firmware
};

type DeviceState = {
  debug: boolean;
  mode: "command" | "data";
};

type ConsoleEntry = {
  direction: "TX" | "RX";
  category: "ACK" | "DATA" | "DEBUG" | "EVENT" | "EXIT" | "INFO";
  text: string;
  timestamp: number;
};

type CommandEntry = {
  name: string;
  description: string;
  usage: string;
  args: ArgDef[];
};

type ArgDef = {
  name: string;
  type: string;
  min?: number;
  max?: number;
  choices?: string[];
};
```

#### Code examples

**Widget example:**

```html
<!DOCTYPE html>
<html>
<head>
  <title>My Solo Serial App</title>
</head>
<body>
  <div id="solo-panel"></div>

  <script src="https://solo-fsw.github.io/solo-serial-web/lib/v0.1/solo-serial.js"></script>
  <script>
    const { device } = SoloSerial.createWidget(
      document.getElementById('solo-panel'),
      {
        filters: [{ usbVendorId: 0x1234, usbProductId: 0x5678 }],
        onConnect: () => console.log('Connected!')
      }
    );
  </script>
</body>
</html>
```

**Programmatic example:**

```html
<!DOCTYPE html>
<html>
<body>
  <button id="connectBtn">Connect Device</button>
  <pre id="output"></pre>

  <script src="https://solo-fsw.github.io/solo-serial-web/lib/v0.1/solo-serial.js"></script>
  <script>
    let device = null;

    document.getElementById('connectBtn').addEventListener('click', async () => {
      const { device: dev, info } = await SoloSerial.connect();
      device = dev;

      device.onConsole(entry => {
        document.getElementById('output').textContent += 
          `[${entry.direction}] ${entry.text}\n`;
      });

      // Call a built-in method
      const pingResp = await device.ping();
      console.log('ping successful:', pingResp.success);

      // Call a custom device method
      const resp = await device.call('blink', 5);
      console.log('exit code:', resp.exitCode);
      console.log('response data:', resp.data);
    });
  </script>
</body>
</html>
```

**Calling methods:**

All device methods return an `RpcResponse` containing:
- `exitCode` — the device's response code (0 = success)
- `data` — array of response lines (from the device)
- `debug` — debug output if enabled
- `events` — async notifications received during the call
- `success` — boolean (true if exitCode === 0)

Built-in methods with convenience wrappers:

```typescript
// Simple status checks
const pingResp = await device.ping();
console.log('Device alive:', pingResp.success);

// Get device info
const infoResp = await device.info();
const info = JSON.parse(infoResp.data[0]); // Parse JSON payload
console.log('Device name:', info.name);
console.log('Firmware version:', info.firmware_version);

// Query available commands
const cmdResp = await device.getCommands();
console.log('Commands:', cmdResp.data); // Array of command definitions

// Control debug output
await device.setDebug(true);  // Enable debug messages
await device.setDebug(false); // Disable
```

Custom methods can be called with any arguments:

```typescript
// Using the call() convenience method (auto-converts arguments to strings):
const resp = await device.call('blink', 5);
console.log('Blink complete:', resp.success);

// For methods returning JSON data:
const resp = await device.call('getStatus');
const status = JSON.parse(resp.data[0]);
console.log('Status:', status);

// Multiple arguments with mixed types:
const resp = await device.call('setColor', 'red', 255, 128, 64);
console.log('Color set:', resp.success);

// Using sendCommand directly (manual string conversion):
const resp = await device.sendCommand('customMethod', '123', 'hello', 'world');
console.log('Response data:', resp.data);
```

---

### Deploying to GitHub Pages

#### Option A — manual (simplest)

1. Build the project:

   ```bash
   npm install
   npm run build
   ```

   This writes output to `dist/`.

2. Go to **Settings → Pages** in your repository.

3. Under *Build and deployment*, choose **Deploy from a branch**.

4. Select the branch with the `dist/` folder, set folder to `/dist`.

5. Save. GitHub will publish at `https://<org>.github.io/<repo>/` within a minute.

> **Base path note:** `vite.config.ts` uses `base: "./"` for relative paths. If GitHub Pages serves from a subdirectory and assets are blank, set `base: "/solo-serial-web/"` in `vite.config.ts`.

#### Option B — GitHub Actions (automated)

This repository includes `.github/workflows/deploy-pages.yml` for automatic deployment on every push to `main`.

In **Settings → Pages**, set source to **GitHub Actions**.

---

### Project structure

```
.
├── index.html             Console app entry point
├── package.json           npm manifest
├── tsconfig.json          TypeScript config
├── vite.config.ts         Build config for console app
├── vite.lib.config.ts     Build config for standalone library
│
├── src/
│   ├── solo-serial.ts     Core library (WebSerial protocol)
│   ├── main.ts            Console UI
│   ├── style.css          Console styles
│   └── lib/
│       ├── index.ts       Public API entry point
│       ├── connect.ts     Connection helpers
│       └── widget.ts      Reusable UI component
│
├── public/
│   └── demo.html          Example code
│
└── dist/                  Build output
    ├── index.html         Console app
    ├── assets/            Compiled JS, CSS
    ├── demo.html          Demo page
    └── lib/v0.1/
        ├── solo-serial.js       Standalone library
        └── solo-serial.js.map
```

### npm scripts

| Command | Action |
|---------|--------|
| `npm run dev`           | Start dev server with hot reload |
| `npm run build`         | Build console app and library |
| `npm run build:app`     | Build console app only |
| `npm run build:lib`     | Build library only |
| `npm run preview`       | Serve built app locally |

---

### Versioning

The library is versioned in the CDN URL path:

- **v0.1**: `https://solo-fsw.github.io/solo-serial-web/lib/v0.1/solo-serial.js`
- **v0.2**: `https://solo-fsw.github.io/solo-serial-web/lib/v0.2/solo-serial.js`
- **v1.0**: `https://solo-fsw.github.io/solo-serial-web/lib/v1.0/solo-serial.js`

Pin to a specific major.minor release to avoid breaking changes. Update the URL in your `<script>` tag when ready to upgrade.
