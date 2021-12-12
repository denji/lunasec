#!/bin/bash

if [[ -z $1 ]]; then
  echo "Must provide a path to the folder to check deps for."
  exit 1
fi

CVE_HASH_PATH="$(pwd)/CVE-2021-44228-Log4Shell-Hashes/sha256sums.txt"

cd $1

BAD_PACKAGES=$(find . -iname "*.jar" | xargs -I% sh -c "sha256sum % | cut -c1-64 | xargs -I^ grep -q ^ $CVE_HASH_PATH && echo %")

if [[ -z $BAD_PACKAGES ]]; then
  echo "No bad packages were found with known any hashes."
  exit 0
fi

for path in $BAD_PACKAGES; do
  echo "Found Vulnerable Package At: $path"
done
