#!/usr/bin/env python3
"""Chrome TLS impersonation fetch helper (free). Tesla may still 403 datacenter IPs."""
import json
import sys

def main():
    try:
        from curl_cffi import requests
    except ImportError:
        print(json.dumps({"ok": False, "error": "curl_cffi not installed"}))
        return 2

    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: fetch_impersonate.py <stationId>"}))
        return 2

    station_id = sys.argv[1]
    session = requests.Session()
    try:
        session.get(
            "https://www.tesla.com/findus",
            impersonate="chrome131",
            timeout=30,
            headers={"Accept-Language": "en-US,en;q=0.9"},
        )
    except Exception:
        pass

    url = "https://www.tesla.com/api/findus/get-charger-details"
    params = {
        "locationSlug": station_id,
        "programType": "supercharger",
        "locale": "en-US",
        "isInHkMoTw": "false",
    }
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.tesla.com/findus",
        "Origin": "https://www.tesla.com",
    }
    try:
        r = session.get(url, params=params, headers=headers, impersonate="chrome131", timeout=45)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1

    text = r.text or ""
    if r.status_code != 200:
        print(json.dumps({"ok": False, "error": f"HTTP {r.status_code}", "status": r.status_code}))
        return 1
    if "Access Denied" in text or text.lstrip().startswith("<HTML>"):
        print(json.dumps({"ok": False, "error": "bot protection"}))
        return 1
    try:
        data = r.json()
    except Exception:
        print(json.dumps({"ok": False, "error": "invalid json"}))
        return 1
    detail = (data.get("data") or {}).get("data")
    if not detail or not detail.get("name"):
        print(json.dumps({"ok": False, "error": "missing detail"}))
        return 1
    print(json.dumps({"ok": True, "detail": detail}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
