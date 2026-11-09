FROM python:3.12-slim
# Every package is pinned because av 18 dropped an argument that faster-whisper 1.2.1 passes to av.open.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Baked in so startup never downloads. With HF_HUB_OFFLINE only this model can load,
# so pick another one with --build-arg WHISPER_MODEL=base, not at runtime.
ARG WHISPER_MODEL=small
RUN python -c "from faster_whisper import download_model; download_model('${WHISPER_MODEL}')"
ENV WHISPER_MODEL=${WHISPER_MODEL} HF_HUB_OFFLINE=1
WORKDIR /app
COPY app.py .
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["python", "app.py"]
