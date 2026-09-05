#!/bin/sh
# Fix type declaration files that may be stripped in some environments.
# Safe to run anywhere — only creates symlinks if type files are missing.

# rxjs: types at dist/types/ but package.json says "types": "index.d.ts"
if [ -f node_modules/rxjs/dist/types/index.d.ts ] && [ ! -f node_modules/rxjs/index.d.ts ]; then
  ln -sf dist/types/index.d.ts node_modules/rxjs/index.d.ts
  echo "Fixed: rxjs types symlink"
fi

# exceljs: types declared but may be stripped
if [ -d node_modules/exceljs ] && [ ! -f node_modules/exceljs/index.d.ts ]; then
  echo 'declare module "exceljs";' > node_modules/exceljs/index.d.ts
  echo "Fixed: exceljs types stub"
fi
