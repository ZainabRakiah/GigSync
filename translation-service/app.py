import os
from flask import Flask, jsonify, request
from IndicTransToolkit import IndicProcessor
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

MODEL = "ai4bharat/indictrans2-en-indic-dist-200M"
app = Flask(__name__)
tokenizer = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
model = AutoModelForSeq2SeqLM.from_pretrained(MODEL, trust_remote_code=True)
processor = IndicProcessor(inference=True)


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.post("/translate")
def translate():
    expected_token = os.getenv("TRANSLATION_SERVICE_TOKEN", "")
    if expected_token and request.headers.get("Authorization") != f"Bearer {expected_token}":
        return jsonify(error="unauthorized"), 401

    body = request.get_json(silent=True) or {}
    text = str(body.get("text", "")).strip()
    source = body.get("source_language", "eng_Latn")
    target = body.get("target_language")
    if not text or source != "eng_Latn" or target not in {"hin_Deva", "kan_Knda"}:
        return jsonify(error="invalid translation request"), 400

    batch = processor.preprocess_batch([text], src_lang=source, tgt_lang=target)
    inputs = tokenizer(batch, padding=True, truncation=True, return_tensors="pt")
    generated = model.generate(**inputs, max_length=512, num_beams=5)
    decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
    result = processor.postprocess_batch(decoded, lang=target)[0]
    return jsonify(translation=result)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
