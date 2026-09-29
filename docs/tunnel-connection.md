# Private tunnel connection

Trace supports OpenAI Secure MCP Tunnel on macOS/Linux. The official
`tunnel-client` opens an outbound connection and launches Trace's local stdio
server. No Trace HTTP server or inbound public port is needed. All four MCP
tools retain their environment-selection rules. Returned session data is sent
to the connected host when requested.

## Prepare

1. Install the official client from the download links in the
   [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
2. Create a dedicated Trace tunnel in
   [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
   and associate the intended workspace. Obtain a runtime key with Tunnels Read
   and Use; creating a tunnel requires Read and Manage. Do not reuse Vault's
   tunnel identity or profile.
3. Build Trace and register the environments you intend to expose, as described
   in [README](../README.md). Environment registration never starts extraction.

```sh
npm ci
npm run build
```

Copy the example only when `.env.tunnel` does not exist:

```sh
cp .env.tunnel.example .env.tunnel
chmod 600 .env.tunnel
```

Edit it locally; do not paste credentials into chat or commit this file:

```dotenv
TRACE_TUNNEL_ID=tunnel_REPLACE_WITH_TRACE_TUNNEL_ID
CONTROL_PLANE_API_KEY=REPLACE_WITH_TRACE_RUNTIME_KEY
TRACE_TUNNEL_PROFILE=trace
# TRACE_CONFIG=/absolute/path/to/trace-config.json
# TUNNEL_CLIENT_PATH=/absolute/path/to/tunnel-client
```

`TRACE_CONFIG` defaults to `~/.config/trace/config.json`. It must exist. An empty
version-1 config with `environments: []` can be used for connection testing; it
exposes no session root until the user registers one. A relative config path is
resolved against the Trace checkout, and `~/` is expanded. Shell variables take
precedence over `.env.tunnel`. The launcher loads neither `.env` nor `.env.http`.
`TUNNEL_CLIENT_PATH` is optional if the executable is on PATH.

## Initialize, verify, and run

```sh
npm run tunnel:init
npm run tunnel:doctor
npm run start:tunnel
# Equivalent startup alias: npm run remote
```

Initialization creates a named local client profile using the official
`sample_mcp_stdio_local` template. It pins absolute Node, bootstrap, and Trace
configuration paths. The API key stays in the client environment, never in the
command string, and the bootstrap removes it before loading the MCP server.
The client health/admin listener uses loopback with an automatically selected
port (`127.0.0.1:0`) to coexist with other plugins. Use the URL reported by the
client; it is not Trace's MCP endpoint.

Keep `start:tunnel` running. Ctrl+C stops it and signals its child process.
Do not run `npm start` separately. `tunnel:init` does not create remote tunnels,
grant account access, or overwrite an existing profile automatically. If a profile
already exists, use a new `TRACE_TUNNEL_PROFILE` for a fresh initialization, or
deliberately update it using the official client's documented profile workflow.
Reinitialize after moving the checkout, switching Node, changing tunnel ID, or
changing the config file path. Editing the contents of the existing Trace config
does not require reinitialization; the MCP server reads it on each request.

## Connect from ChatGPT

Keep the tunnel client healthy, then use a developer-mode connection with
**Connection → Tunnel** and select the Trace tunnel. Availability depends on
account/workspace permissions. Start by calling `list_environments`. Select a
registered environment before calling `list_local_sessions` or
`extract_local_events`; the server does not scan all roots automatically.

After code changes, rebuild and restart. After tool changes, refresh the host's
connection metadata and start a new conversation. This is a private connection,
not a public plugin deployment. Follow the
[official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Troubleshooting and verification scope

- Missing configuration: run CLI setup or point `TRACE_CONFIG` to an existing config.
- Missing ID/key: edit `.env.tunnel`; placeholders are rejected.
- Client missing: install the official binary or set `TUNNEL_CLIENT_PATH`.
- Profile exists: preserve it; use a new name or explicitly update that profile.
- Discovery fails: keep the process running and run `npm run tunnel:doctor`;
  check workspace association and key permissions.
- Shutdown: Ctrl+C stops this client. Remove/revoke remote connections and keys
  separately if permanently retiring the integration.

Automated tests use a fake client to check argument quoting, profile selection,
environment precedence, exit codes, and signal forwarding. A real local MCP
handshake verifies the pinned-config bootstrap and tool discovery. These checks
do not establish live tunnel authentication or ChatGPT discovery; verify those
with the intended account before claiming an end-to-end connection.

[한국어](../notes/ko/docs/tunnel-connection.md)
