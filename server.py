"""FloodTwin entry point.

Local dev:  python server.py            (Flask on :9121)
Production: gunicorn server:app

The application itself is assembled in floodtwin/__init__.py; this file only
exists so `server:app` keeps working for existing process managers.
"""
import os

from floodtwin import create_app

app = create_app()

if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "9121")),
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
    )

