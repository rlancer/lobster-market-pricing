FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    MAX_SYMBOLS=503 \
    MAX_BATCH_RECORDS=250 \
    HTTP_RETRIES=3 \
    RETRY_BACKOFF_SECONDS=1 \
    WRITE_MODE=stdout

WORKDIR /app
COPY symbols/sp500_constituents.json /app/sp500_constituents.json

EXPOSE 8080
CMD ["python", "/app/loader.py"]
