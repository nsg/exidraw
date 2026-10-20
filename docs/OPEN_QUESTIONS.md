# Open questions

## Decided

1. **Anonymous share links:** none. Every viewer logs in; sharing is the room
   URL plus a grant.
2. **Top-level creation:** only admins, unless someone is granted editor on
   the root folder.
3. **Retention:** rooms are soft-deleted, files are never deleted, 100
   snapshots per room. Revisit with a purge job if the volume gets small.
4. **Groups:** grants go to all logged-in users or to specific people.
   Entra groups can be added later as a new principal kind.
5. **Architecture:** amd64 only.

## Open

1. **Entra app registration:** tenant ID, client ID, client secret, the
   `https://<host>/auth/callback` redirect URI and the optional `acct` claim
   are needed for the first real login test.
2. **Public image:** the image includes Google's Chrome for Testing headless
   shell. Check its redistribution terms, or switch to Debian's `chromium`,
   before publishing the image outside the organisation.
3. **TypeScript 7:** pinned to 5.9.3 for predictability; move once the
   prototype is stable.
