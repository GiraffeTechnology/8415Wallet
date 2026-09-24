# console/

`createConsole` requires an `authenticate(request)` function. Integrate a verified
session or credential provider and return its user identifier, or `undefined`
for an unauthenticated request. Authentication errors return 401. The directory
then enforces that subject's role. There is no identity-header fallback.

`handleConsole` is the internal handler; its `user` is an already authenticated
subject and must never be populated directly from an unverified request field.
