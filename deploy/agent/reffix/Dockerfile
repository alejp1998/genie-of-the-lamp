# reffix behind a small HTTP API for the Genie Agent Gateway's
# check_bibliography tool. Internal network only; never published.
FROM python:3.12-slim
RUN pip install --no-cache-dir reffix==1.3.2
COPY server.py /srv/server.py
USER nobody
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["python", "/srv/server.py"]
