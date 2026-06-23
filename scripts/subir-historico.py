#!/usr/bin/env python3
import json, base64, urllib.request, os, sys

token = os.environ.get('GITHUB_TOKEN','')
repo  = os.environ.get('GITHUB_REPOSITORY','')
path  = 'data/historico_adjudicaciones.json'

if not token or not repo:
    print("ERROR: Faltan GITHUB_TOKEN o GITHUB_REPOSITORY")
    sys.exit(1)

with open(path, 'rb') as f:
    content = base64.b64encode(f.read()).decode()

print(f"Fichero: {len(content)} chars base64")

req = urllib.request.Request(
    f'https://api.github.com/repos/{repo}/contents/{path}',
    headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
try:
    with urllib.request.urlopen(req) as r:
        sha = json.load(r)['sha']
    print(f"SHA actual: {sha[:8]}")
except Exception as e:
    sha = None
    print(f"Sin SHA previo: {e}")

year = sys.argv[1] if len(sys.argv) > 1 else 'backfill'
payload = {'message': f'Backfill {year}: historico actualizado', 'content': content}
if sha: payload['sha'] = sha

req2 = urllib.request.Request(
    f'https://api.github.com/repos/{repo}/contents/{path}',
    data=json.dumps(payload).encode(), method='PUT',
    headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
             'Content-Type': 'application/json'})
with urllib.request.urlopen(req2) as r:
    print(f'Subido OK: HTTP {r.status}')
