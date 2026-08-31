# GigSync Translation Service

Separate persistent service for IndicTrans2. The model loads once at startup.

```powershell
cd translation-service
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:TRANSLATION_SERVICE_TOKEN="local-dev-token"
python app.py
```

Set `TRANSLATION_SERVICE_URL=http://localhost:8000` and the same token in the
main GigSync server environment. Keep both values server-side.
