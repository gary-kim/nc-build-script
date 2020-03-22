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

You can find a list of currently supported Nextcloud build versions in the [configs](configs) directory.

You can also specify a custom config. Look in the help options for that.

### Currently Missing

List of things in the official release that are not in releases made by this script.

* Documentation
    * The official release contains documentation.
    * Planned
* Signing
    * The official script signs all apps and the release itself.
    * Planned (provide your own keys)
* Support app
    * The support app is currently only in a private repo so is not publicly available so cannot be included in these releases. Strictly speaking, it could be pulled out of the official release and repackaged as the `appinfo/info.xml` indicates that it is `agpl` licensed but the point of this script is to be able to generate releases without having to use the official releases.
* Exclude list different
    * The exact exclude list used is different so some files that are in the official release are excluded in this release. Things such as extra test files are unnecessary but in the official release are removed in this script.

### License

Licensed under [AGPL-3.0-or-later](LICENSE)

Copyright &copy; 2019 Gary Kim &lt;<gary@garykim.dev>&gt;
