TOK=$(python3 -c "import json;print(json.load(open('/Users/yoimaro/.gemini/oauth_creds.json'))['access_token'])")
PROJ=engineering-478708
echo "### responseModalities=[TEXT,IMAGE] probe"
for M in gemini-2.5-flash gemini-3-flash gemini-3.5-flash; do
  R=$(curl -s -w "\n@@%{http_code}" -X POST "https://cloudcode-pa.googleapis.com/v1internal:generateContent" \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"model\":\"$M\",\"project\":\"$PROJ\",\"request\":{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"Generate an image of a red shrimp\"}]},],\"generationConfig\":{\"responseModalities\":[\"TEXT\",\"IMAGE\"]}}}")
  echo "--- $M : $(echo "$R"|tail -1|tr -d '@') $(echo "$R"|sed '$d'|head -c 300)"
done
echo; echo "### model list endpoints"
for EP in "v1internal/models" "v1internal:listModels" "v1internal/models?pageSize=200"; do
  echo "--- $EP -> $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "https://cloudcode-pa.googleapis.com/$EP")"
done
