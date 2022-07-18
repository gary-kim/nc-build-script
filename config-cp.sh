#!/usr/bin/env bash

set -euf -o pipefail

# This line will only work in scripts and not sourced bash scripts.
SCRIPTPATH="$( cd "$(dirname "$0")" ; pwd -P )"

if [ $# -lt 2 ]; then
        echo "Not enough arguments provided."
        echo "Usage: $0 from_version to_version"
        exit -1
fi

cp "configs/v$1.json" "configs/v$2.json"
sed -i "s/$1/$2/g" "configs/v$2.json"
