# api/

`createApi({ tenants, keys, metrics })` routes every HTTP request through the
credential and tenant gateway. Supply `Authorization: Bearer <key>` with an
issued, non-revoked tenant key. Missing or invalid keys return 401. `handle`
is an internal route function for an already selected store, not an HTTP server.

JS SDK: `new ProjectionClient({ baseUrl, apiKey })`.
Python SDK: `ProjectionClient(base_url, api_key=key)`.
Default SDK transports refuse redirects and require HTTPS except on loopback.
Custom Python openers own authentication and cannot be combined with `api_key`.
