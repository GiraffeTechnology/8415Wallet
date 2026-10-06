# PR58 synthetic migration source fixture

`auth-pr58-source.tar.gz` contains only public source files obtained from
GiraffeTechnology/8415Wallet commit
`a942495d6b6913a0026a6c2a8ce27eed9e9098f2`. Its SHA-256 is
`0cadf4a479f5629813bd01e8df9d2ffbbafbdb10be050a1ad3eb27577e7aadc7`.
The importer separately pins every included file's Git blob identity.

The fixture carries no deployment configuration, wallet binding, credential,
key or encrypted state. Tests generate temporary synthetic data and inject host
service commands. The installed journey uses the publicly known synthetic
credential defined in the test helper; it is never a production credential.

Frozen historical source is recognition evidence, not current product policy.
Its historical port conditions do not impose a port reservation on the importer
or on another deployment; current listener reservations are operator-owned data.
