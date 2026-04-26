{
  description = "HAL flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
        lib = pkgs.lib;

        python = pkgs.python312;
        nodejs = pkgs.nodejs_24;
        nodeGyp = pkgs.node-gyp;
        linuxElectronDistPath = lib.optionalString pkgs.stdenv.isLinux "${pkgs.electron}/bin";
        nixfmt = pkgs.nixfmt;

        serverPackageJson = builtins.fromJSON (builtins.readFile ./apps/server/package.json);

        bootstrapToolchain = [
          pkgs.bun
          nodejs
          python
          nodeGyp
          pkgs.git
          pkgs.pkg-config
          pkgs.gnumake
          pkgs.clang
          pkgs.coreutils
        ]
        ++ lib.optionals pkgs.stdenv.isDarwin [
          pkgs.libiconv
          pkgs.cctools
        ];

        devShellPackages =
          bootstrapToolchain
          ++ (with pkgs; [
            jq
            ripgrep
            fd
            just
            sqlite
            nix
            nixfmt
            statix
            deadnix
          ]);

        sourcePath = toString self;
        sourceKey = builtins.baseNameOf sourcePath;

        makeLauncher =
          {
            name,
            description,
            buildTarget,
            execCommand,
          }:
          pkgs.writeShellApplication {
            inherit name;
            runtimeInputs = bootstrapToolchain;
            text = ''
              set -euo pipefail

              cache_root="''${T3CODE_FLAKE_CACHE_DIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/t3code-flake}"
              workspace="$cache_root/${sourceKey}"
              source_dir="${sourcePath}"

              acquire_lock() {
                local lock_dir="$1"
                until mkdir "$lock_dir" 2>/dev/null; do
                  sleep 0.2
                done
              }

              release_lock() {
                local lock_dir="$1"
                rmdir "$lock_dir" 2>/dev/null || true
              }

              run_with_lock() {
                local lock_dir="$1"
                shift

                acquire_lock "$lock_dir"

                local status=0
                "$@" || status=$?

                release_lock "$lock_dir"
                return "$status"
              }

              deps_layout_is_complete() {
                local electron_package_dir="$workspace/apps/desktop/node_modules/electron"
                local electron_package_json="$electron_package_dir/package.json"
                local electron_path_file="$electron_package_dir/path.txt"
                local electron_relative_path=""
                local nix_electron_dist_path="${linuxElectronDistPath}"

                if [ -n "$nix_electron_dist_path" ]; then
                  [ -e "$workspace/apps/web/node_modules/.bin/vite" ] &&
                  [ -e "$workspace/apps/server/node_modules/.bin/tsdown" ] &&
                  [ -e "$workspace/apps/desktop/node_modules/.bin/electron" ] &&
                  [ -e "$workspace/apps/desktop/node_modules/.bin/tsdown" ] &&
                  [ -e "$electron_package_json" ] &&
                  [ -x "$nix_electron_dist_path/electron" ]
                  return
                fi

                if [ -f "$electron_path_file" ]; then
                  electron_relative_path="$(cat "$electron_path_file")"
                fi

                [ -e "$workspace/apps/web/node_modules/.bin/vite" ] &&
                [ -e "$workspace/apps/server/node_modules/.bin/tsdown" ] &&
                [ -e "$workspace/apps/desktop/node_modules/.bin/electron" ] &&
                [ -e "$workspace/apps/desktop/node_modules/.bin/tsdown" ] &&
                [ -n "$electron_relative_path" ] &&
                [ -e "$electron_package_dir/dist/$electron_relative_path" ]
              }

              deps_are_ready() {
                [ -f "$workspace/.deps-ready" ] && deps_layout_is_complete
              }

              web_build_is_ready() {
                [ -f "$workspace/apps/server/dist/bin.mjs" ] &&
                [ -f "$workspace/apps/server/dist/client/index.html" ]
              }

              desktop_build_is_ready() {
                web_build_is_ready &&
                [ -f "$workspace/apps/desktop/dist-electron/main.cjs" ] &&
                [ -f "$workspace/apps/desktop/dist-electron/preload.cjs" ]
              }

              init_workspace() {
                if [ -f "$workspace/.source-ready" ]; then
                  return 0
                fi

                rm -rf "$workspace"
                mkdir -p "$workspace"
                cp -R "$source_dir/." "$workspace/"
                chmod -R u+w "$workspace"
                touch "$workspace/.source-ready"
              }

              install_deps() {
                if [ -f "$workspace/.deps-ready" ]; then
                  return 0
                fi

                rm -rf \
                  "$workspace/node_modules" \
                  "$workspace/apps/"*/node_modules \
                  "$workspace/packages/"*/node_modules

                (
                  cd "$workspace"
                  bun install --no-progress --frozen-lockfile
                )

                if ! deps_layout_is_complete; then
                  echo "bun install completed without expected workspace binaries" >&2
                  return 1
                fi

                touch "$workspace/.deps-ready"
              }

              build_web_server_workspace() {
                rm -rf \
                  "$workspace/apps/web/dist" \
                  "$workspace/apps/server/dist"

                (
                  cd "$workspace/apps/web"
                  bun run build
                )

                (
                  cd "$workspace/apps/server"
                  bun run build
                )

                if ! web_build_is_ready; then
                  echo "web/server build completed without expected runtime artifacts" >&2
                  return 1
                fi
              }

              build_desktop_workspace() {
                if ! web_build_is_ready; then
                  build_web_server_workspace
                fi

                rm -rf "$workspace/apps/desktop/dist-electron"

                (
                  cd "$workspace/apps/desktop"
                  bun run build
                )

                if ! desktop_build_is_ready; then
                  echo "desktop build completed without expected runtime artifacts" >&2
                  return 1
                fi
              }

              mkdir -p "$cache_root"

              if [ ! -f "$workspace/.source-ready" ]; then
                run_with_lock "$workspace.init.lock" init_workspace
              fi

              export PYTHON="${python}/bin/python3"
              export npm_config_python="${python}/bin/python3"
              export NODE_GYP="${nodeGyp}/bin/node-gyp"
              export npm_config_node_gyp="${nodeGyp}/bin/node-gyp"
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
              ${lib.optionalString pkgs.stdenv.isLinux ''
                export ELECTRON_OVERRIDE_DIST_PATH="${linuxElectronDistPath}"
              ''}

              if ! deps_are_ready; then
                rm -f "$workspace/.deps-ready"
                run_with_lock "$workspace.deps.lock" install_deps
              fi

              build_target="${buildTarget}"

              case "$build_target" in
                desktop)
                  if ! desktop_build_is_ready; then
                    run_with_lock "$workspace.build.lock" build_desktop_workspace
                  fi
                  ;;
                web)
                  if ! web_build_is_ready; then
                    run_with_lock "$workspace.build.lock" build_web_server_workspace
                  fi
                  ;;
                *)
                  echo "unknown flake launch target: ${buildTarget}" >&2
                  exit 1
                  ;;
              esac

              ${execCommand}
            '';
            meta = {
              inherit description;
              homepage = "https://github.com/dengor21/t3code";
              license = lib.licenses.mit;
              mainProgram = name;
              platforms = lib.platforms.unix;
            };
          };

        t3 = makeLauncher {
          name = "t3";
          description = "Run HAL web/server mode from the flake with a cached Bun workspace bootstrap";
          buildTarget = "web";
          execCommand = ''
            exec ${nodejs}/bin/node "$workspace/apps/server/dist/bin.mjs" "$@"
          '';
        };

        halDesktop = makeLauncher {
          name = "hal-desktop";
          description = "Run HAL desktop mode from the flake with a cached Bun workspace bootstrap";
          buildTarget = "desktop";
          execCommand = ''
            cd "$workspace/apps/desktop"
            exec ${nodejs}/bin/node scripts/start-electron.mjs "$@"
          '';
        };
      in
      {
        formatter = nixfmt;

        packages = {
          default = halDesktop;
          desktop = halDesktop;
          web = t3;
          t3 = t3;
        };

        apps = {
          default = flake-utils.lib.mkApp { drv = halDesktop; };
          desktop = flake-utils.lib.mkApp { drv = halDesktop; };
          web = flake-utils.lib.mkApp { drv = t3; };
          t3 = flake-utils.lib.mkApp { drv = t3; };
        };

        checks = {
          default = pkgs.runCommand "t3-flake-check" { } ''
            test -x ${halDesktop}/bin/hal-desktop
            test -x ${t3}/bin/t3
            touch $out
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = devShellPackages;

          shellHook = ''
            export PATH="${python}/bin:$PATH"
            export PYTHON="${python}/bin/python3"
            export npm_config_python="${python}/bin/python3"
            export NODE_GYP="${nodeGyp}/bin/node-gyp"
            export npm_config_node_gyp="${nodeGyp}/bin/node-gyp"
            ${lib.optionalString pkgs.stdenv.isLinux ''
              export ELECTRON_OVERRIDE_DIST_PATH="${linuxElectronDistPath}"
            ''}

            # Keep the default shell lean; browser binaries stay opt-in.
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

            echo "HAL dev shell"
            echo "Node: $(node --version)"
            echo "Bun:  $(bun --version)"
            echo "Nix:  $(nix --version)"
            echo "App:  t3 (${serverPackageJson.version})"
          '';
        };
      }
    );
}
