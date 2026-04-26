{
  description = "HAL flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
        lib = pkgs.lib;

        python = pkgs.python312;
        nodejs = pkgs.nodejs_24;
        nixfmt = pkgs.nixfmt;

        serverPackageJson = builtins.fromJSON (builtins.readFile ./apps/server/package.json);

        bootstrapToolchain = with pkgs; [
          bun
          nodejs
          python
          git
          pkg-config
          gnumake
          clang
          coreutils
        ] ++ lib.optionals pkgs.stdenv.isDarwin [
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

        t3 = pkgs.writeShellApplication {
          name = "t3";
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

              touch "$workspace/.deps-ready"
            }

            build_workspace() {
              if [ -f "$workspace/apps/server/dist/bin.mjs" ]; then
                return 0
              fi

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
            }

            mkdir -p "$cache_root"

            if [ ! -f "$workspace/.source-ready" ]; then
              run_with_lock "$workspace.init.lock" init_workspace
            fi

            export PYTHON="${python}/bin/python3"
            export npm_config_python="${python}/bin/python3"
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

            if [ ! -f "$workspace/.deps-ready" ]; then
              run_with_lock "$workspace.deps.lock" install_deps
            fi

            if [ ! -f "$workspace/apps/server/dist/bin.mjs" ]; then
              run_with_lock "$workspace.build.lock" build_workspace
            fi

            exec ${nodejs}/bin/node "$workspace/apps/server/dist/bin.mjs" "$@"
          '';
          meta = {
            description = "Run HAL from the flake with a cached Bun workspace bootstrap";
            homepage = "https://github.com/dengor21/t3code";
            license = lib.licenses.mit;
            mainProgram = "t3";
            platforms = lib.platforms.unix;
          };
        };
      in
      {
        formatter = nixfmt;

        packages = {
          default = t3;
          t3 = t3;
        };

        apps = {
          default = flake-utils.lib.mkApp { drv = t3; };
          t3 = flake-utils.lib.mkApp { drv = t3; };
        };

        checks = {
          default = pkgs.runCommand "t3-flake-check" { } ''
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
