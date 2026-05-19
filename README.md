# Comprints Backend

Node.js + Express + MongoDB API for storing the landing page content used by the frontend admin panel.

## Run

```bash
cd comprints-backend
npm install
npm start
```

## Environment

Copy `.env.example` to `.env` and set your MongoDB connection strings.

The frontend should send `GET /api/content` to load content and `PUT /api/content` with `{ content }` to save updates.
# cimprintbackend-
