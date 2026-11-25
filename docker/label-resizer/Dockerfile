# label-resizer: resizes a designed label keeping its original design (PyMuPDF).
# Separate image: Python + MuPDF, nothing else. One request at a time.
FROM python:3.12-slim

RUN pip install --no-cache-dir pymupdf==2.1

WORKDIR /srv
COPY resizer.py server.py ./
COPY fonts ./fonts

ENV PORT=5080 \
    RESIZER_FONT_DIR=/srv/fonts \
    PYTHONUNBUFFERED=1

RUN useradd --system --no-create-home resizer
USER resizer

EXPOSE 5080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5080/health', timeout=4).status == 200 else 1)"
CMD ["python", "server.py"]
