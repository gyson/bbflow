# Remote access with Tailscale Serve

This guide tells you how to open the bbflow web UI on another device, such as a phone.
[Tailscale Serve](https://tailscale.com/kb/1312/serve) is a part of the Tailscale
client. It gives the computer of the server an HTTPS address that only the devices of
your tailnet can open. bbflow does not start, change, or stop Tailscale Serve.

Remote access is off by default. While it is on, each device where your Tailscale user
is signed in can run commands on the computer of the server as you. See
[Remote access](SPEC.md#remote-access) in `SPEC.md` for the exact rules and the limits.

## Requirements

- A Tailscale account.
- The Tailscale client on the computer of the server and on the remote device. The same
  Tailscale user must be signed in on both.
- The `tailscale` command on the computer of the server. The Tailscale app for macOS
  does not put it on the `PATH`. Its path is
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

## Set up remote access

Do steps 1 to 5 on the computer of the server. In the examples, the port of the server
is `50000`, the Tailscale host name is `my-mac.example.ts.net`, and the Tailscale login
is `user@example.com`.

1. Set a fixed port, so that the port stays the same after each start. Use **Port** in
   the **Server** card of Settings, or the first command below. Then restart the
   server. A restart ends the sessions of the instance.

   ```sh
   bbflow settings set port 50000
   bbflow server restart
   ```

2. Start Tailscale Serve for that port.

   ```sh
   tailscale serve --bg 50000
   ```

   - The command prints the address, such as `https://my-mac.example.ts.net/`. The
     Tailscale host name is the name in that address.
   - With `--bg`, Tailscale keeps this configuration until you remove it.
   - At the first use in a tailnet, the command prints `Serve is not enabled on your
     tailnet` and a link. Open the link, sign in to Tailscale, and approve. This enables
     HTTPS certificates for the tailnet. Then run the command again.

3. Find your Tailscale login. The menu of the Tailscale app shows it, and so does the
   **Users** page of the Tailscale admin console.

4. Save the host name and the login. Use the **Remote access** card of Settings, or
   these commands. The second command prints `Remote access is on.`

   ```sh
   bbflow settings set remote-host my-mac.example.ts.net
   bbflow settings set remote-login user@example.com
   ```

5. Request the address. The command prints `200` when remote access works. The first
   request can take about 30 seconds, because Tailscale gets the certificate then.

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://my-mac.example.ts.net/
   ```

6. On the remote device, connect Tailscale. Then open `https://my-mac.example.ts.net/`
   in a browser.

## Turn remote access off

To turn remote access off, save an empty value for one of the two settings. To remove
the address too, run `tailscale serve reset`.

```sh
bbflow settings set remote-host ""
tailscale serve reset
```

## Tailscale Serve commands

| Command | Effect |
| --- | --- |
| `tailscale serve --bg PORT` | Forwards `https://HOST/` to the loopback port `PORT`. |
| `tailscale serve --bg --https=8443 PORT` | Forwards `https://HOST:8443/` to the loopback port `PORT`. |
| `tailscale serve status` | Shows each address and its port. |
| `tailscale serve --https=8443 off` | Removes the address of HTTPS port 8443. Use `443` for the address without a port. |
| `tailscale serve reset` | Removes all addresses. |
| `tailscale status` | Lists the devices of the tailnet and tells which ones are connected. |

Each address is available only inside the tailnet. Do not use `tailscale funnel`.
Funnel makes an address public, and bbflow rejects its requests.

## More than one instance

A computer has one Tailscale host name. Thus each instance needs its own HTTPS port in
Tailscale Serve, and its own fixed server port. The `remote-host` value of an
instance includes the HTTPS port, unless that port is 443.

| Instance | Serve command | Address | `remote-host` |
| --- | --- | --- | --- |
| Server port 50000 | `tailscale serve --bg 50000` | `https://my-mac.example.ts.net/` | `my-mac.example.ts.net` |
| Server port 50001 | `tailscale serve --bg --https=8443 50001` | `https://my-mac.example.ts.net:8443/` | `my-mac.example.ts.net:8443` |

- Save `remote-host` and `remote-login` in each instance. Select the instance with
  `--dir` or `BBFLOW_DIR`.
- The server compares the complete Host, with its port. Thus the address of one
  instance does not open another instance.
- Do not put an instance below a path, such as `--set-path=/dev`. The web UI loads its
  files and its WebSocket connection from the root of the host.

## Problems

| Result | Cause | Action |
| --- | --- | --- |
| The command prints `Serve is not enabled on your tailnet`. | The tailnet does not permit Serve yet. | Open the link that the command prints, and approve. Then run the command again. |
| The page shows `invalid host`. | Remote access is off, or the address is not the saved `remote-host`. | Save both values. Include the HTTPS port in `remote-host`, unless it is 443. |
| The page shows `remote access needs the Tailscale login of Settings`. | The device is signed in as another Tailscale user, or it has a Tailscale tag. | Save the login of the device as `remote-login`, or sign in as the saved user. |
| The browser cannot find or open the address. | Tailscale is not connected on the remote device, or on the computer of the server. | Connect Tailscale on both. `tailscale status` shows the state. |
| The browser shows status 502. | The bbflow server does not run, or it has another port than the Serve address. | Start the server. Compare its port with `tailscale serve status`. |
| The page opens, then the connection closes. | A save changed `remote-host` or `remote-login`. | Reload the page. |
