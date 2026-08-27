#!/usr/bin/env python3
"""Warm the IMSA nginx proxy_cache before real visitors hit it cold.

Walks the same tree the client-side app does (season -> venues -> series ->
race sessions + points data) and just GETs every URL so nginx's proxy_cache
on /imsa-data/ populates. Run once a day, shortly before the cache's 24h TTL
would otherwise expire, via cron.

No dependencies beyond the stdlib — this runs directly on the host, not
inside the container.
"""
import re
import urllib.parse
import urllib.request

HOST = "justsports.duckdns.org"
BASE = "http://localhost/imsa-data/"
SERIES_MATCH = ("mx-5 cup", "michelin pilot challenge", "weathertech sportscar championship")

HREF_RE = re.compile(r'<a href="([^"?][^"]*)">')


def fetch(path):
    req = urllib.request.Request(BASE + path, headers={"Host": HOST})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def hrefs(path):
    # Hrefs in the Apache listing are already percent-encoded, so they can be
    # concatenated directly onto BASE without re-encoding.
    return [h for h in HREF_RE.findall(fetch(path)) if not h.startswith("/")]


def main():
    seasons = sorted((h for h in hrefs("Results/") if h.endswith("/")), reverse=True)
    if not seasons:
        print("No seasons found — nothing to warm.")
        return
    season = seasons[0]
    venues = sorted(
        (h for h in hrefs("Results/" + season) if h.endswith("/")),
        key=lambda h: int(h.split("_", 1)[0]),
        reverse=True,
    )

    warmed = 0
    for venue in venues:
        venue_path = f"Results/{season}{venue}"
        for series_dir in [h for h in hrefs(venue_path) if h.endswith("/")]:
            decoded = urllib.parse.unquote(series_dir).lower()
            if not any(m in decoded for m in SERIES_MATCH):
                continue
            event_path = venue_path + series_dir
            for item in hrefs(event_path):
                decoded_item = urllib.parse.unquote(item).lower()
                if not item.endswith("/"):
                    continue
                if "race" in decoded_item:
                    for f in hrefs(event_path + item):
                        if re.match(r"^03_results.*\.json$", f, re.I):
                            fetch(event_path + item + f)
                            warmed += 1
                elif "points" in decoded_item and "data" in decoded_item:
                    for f in hrefs(event_path + item):
                        if re.search(r"drivers\.json$", f, re.I) and "award" not in f.lower():
                            fetch(event_path + item + f)
                            warmed += 1
    print(f"Warmed {warmed} IMSA result/points files for season {season.strip('/')}.")


if __name__ == "__main__":
    main()
