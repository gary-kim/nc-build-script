# Build Script for Use with Nextcloud

**This script and repo is unaffiliated with Nextcloud GmbH**

This is a build script for use with Nextcloud.

This script does not include signing or actually releasing a build.

### How to Run

**Requires Node v12 or later**

```bash
npm ci
npm start -- --help
npm start -- build

# Build v17.0.4
npm start -- build --nc-version v17.0.4
```

### License

Licensed under [AGPL-3.0-or-later](LICENSE)

Copyright &copy; 2019 Gary Kim &lt;<gary@garykim.dev>&gt;
