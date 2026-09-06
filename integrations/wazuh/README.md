# Wazuh → MENATER

Four commands on the Wazuh manager, one block in `ossec.conf`. No parser to
write, no field mapping to maintain: the script forwards the alert exactly as
Wazuh wrote it, and MENATER's `wazuh` mapping does the rest.

## Before you start

In the MENATER console, open **Settings → Ingestion** and:

1. set a **shared secret** (the endpoint stays closed without one — that is
   deliberate: an ingestion endpoint with no authentication accepts alerts from
   anyone, and an alert can lead to a machine being isolated);
2. set the mode to **Principal**.

## Install

```bash
# 1. copy the script (from this repository) onto the Wazuh manager
scp integrations/wazuh/custom-menater root@wazuh-manager:/var/ossec/integrations/

# 2. ownership and permissions -- the Integrator ignores anything else
chmod 750 /var/ossec/integrations/custom-menater
chown root:wazuh /var/ossec/integrations/custom-menater

# 3. restart the manager
systemctl restart wazuh-manager
```

> On Wazuh 4.2 and older the group is `ossec`, not `wazuh`. If
> `chown: invalid group` appears, use `chown root:ossec`.

## Configure

In `/var/ossec/etc/ossec.conf`, inside `<ossec_config>`:

```xml
<integration>
  <name>custom-menater</name>
  <hook_url>http://menater.example:4400/api/ingest/wazuh</hook_url>
  <api_key>YOUR_SHARED_SECRET</api_key>
  <level>7</level>
  <alert_format>json</alert_format>
</integration>
```

| Field | What it does |
|---|---|
| `name` | Must match the filename exactly, and must start with `custom-` |
| `hook_url` | Your console, path included. `/api/ingest/wazuh` selects the mapping |
| `api_key` | The shared secret from Settings → Ingestion. Sent as `X-SOC-Token` |
| `level` | **The volume dial.** Only alerts at or above this level are forwarded |
| `alert_format` | Must be `json` |

`<level>` is the setting to think about. Wazuh generates a great deal at low
levels; every forwarded alert costs a model call. Start at `7` and lower it
once you have seen what arrives. `<group>` and `<rule_id>` narrow it further —
for example `<group>authentication_failures</group>`.

## Check it works

```bash
tail -f /var/ossec/logs/integrations.log
```

Silence means success — the script only logs problems, unless you add a fourth
argument to enable debug. Then, in the console, open **Alerts**: a forwarded
alert appears as a case within seconds.

| Message | Meaning |
|---|---|
| `no <api_key> configured` | The `<api_key>` line is missing. MENATER answers 401 without it |
| `refused ... HTTP 401` | The secret does not match Settings → Ingestion |
| `refused ... HTTP 404 unknown_source` | The `hook_url` path is wrong — it must end in `/api/ingest/wazuh` |
| `refused ... HTTP 503 webhook_disabled` | Mode is still `Closed` in Settings → Ingestion |
| `giving up ... Connection refused` | The console is unreachable from the manager. Check the URL, the port, and any firewall |
| nothing at all in the log | Wazuh is not running the script. Re-check the filename, the `custom-` prefix, `chmod 750` and `chown` |

## What gets sent

The whole Wazuh alert, unmodified. MENATER maps it:

| MENATER | Wazuh |
|---|---|
| `alert_id` | `id` |
| `rule_name` | `rule.description` |
| `severity` | `rule.level` — 0–3 `low`, 4–7 `medium`, 8–11 `high`, 12–15 `critical` |
| `raw_log` | `full_log`, or `previous_output` for a grouped alert |
| `source_ip` / `user` / `host` | `data.srcip` / `data.srcuser` / `agent.name` |
| `dest_ip` | `data.dstip` — **usually absent, and that is fine** |
| everything else | kept whole in `extensions`, never discarded |

A missing observable is shown as missing. Nothing is invented to fill it, and
`isolate_host_temporary` refuses to run when there is no host to name.

## HTTPS

If the console sits behind a self-signed certificate, the manager will reject
it. Fix the certificate rather than the script. If you must, for a lab only:

```xml
<integration>
  <name>custom-menater</name>
  ...
</integration>
```

and set `MENATER_INSECURE=1` in the manager's environment. The shared secret
and the alert both travel in that request, so this is not a production option.
