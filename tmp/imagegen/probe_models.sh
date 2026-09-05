#!/bin/bash
TOK=$(python3 -c "import json;print(json.load(open('/Users/yoimaro/.gemini/oauth_creds.json'))['access_token'])")
PROJ=engineering-478708
for M in gemini-2.5-flash gemini-3-flash gemini-3-pro-preview gemini-3.1-pro-preview gemini-3.5-flash \
         gemini-2.5-flash-image gemini-2.5-flash-image-preview gemini-3-pro-image-preview \
         gemini-3.1-flash-image gemini-3.1-flash-image-preview gemini-3.1-flash-lite-image-preview \
         gemini-3.8-flash gemini-3.8-flash-image imagen-4.0-generate-001; do
  R=$(curl -s -w "\n@@%{http_code}" -X POST "https://cloudcode-pa.googleapis.com/v1internal:generateContent" \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"model\":\"$M\",\"project\":\"$PROJ\",\"request\":{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"say OK\"}]}]}}")
  CODE=$(echo "$R" | tail -1 | sed 's/@@//')
  MSG=$(echo "$R" | sed '$d' | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
except Exception as e:
    print('parse-err'); raise SystemExit
if 'error' in d: print(d['error'].get('status'),'|',d['error'].get('message','')[:110])
else:
    r=d.get('response',d)
    c=r.get('candidates',[{}])[0]
    parts=c.get('content',{}).get('parts',[])
    print('OK |', ','.join(sorted(set(k for p in parts for k in p))), '|', (parts[0].get('text','') if parts else '')[:40].replace(chr(10),' '))
")
  printf "%-38s %s  %s\n" "$M" "$CODE" "$MSG"
done
