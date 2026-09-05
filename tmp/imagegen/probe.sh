#!/bin/bash
TOK=$(python3 -c "import json;print(json.load(open('/Users/yoimaro/.gemini/oauth_creds.json'))['access_token'])")
PROJ="${GOOGLE_CLOUD_PROJECT:-engineering-478708}"
# loadCodeAssist to see tier/allowed
curl -s -X POST "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"cloudaicompanionProject\":\"$PROJ\",\"metadata\":{\"ideType\":\"IDE_UNSPECIFIED\",\"platform\":\"PLATFORM_UNSPECIFIED\",\"pluginType\":\"GEMINI\"}}" | python3 -m json.tool
