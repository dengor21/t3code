{
  description = "Development shell for the T3code deployment fork";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };

        python = pkgs.python312;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            bun
            python
            git
            jq
            ripgrep
            fd
            just
            pkg-config
            gnumake
            clang
            sqlite
            nix
            nixfmt-rfc-style
            statix
            deadnix
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.libiconv
            pkgs.cctools
          ];

          shellHook = ''
            export PATH="${python}/bin:$PATH"
            export PYTHON="${python}/bin/python3"
            export npm_config_python="${python}/bin/python3"

            # Keep the default shell lean; browser binaries stay opt-in.
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

            echo "T3code dev shell"
            echo "Node: $(node --version)"
            echo "Bun:  $(bun --version)"
            echo "Nix:  $(nix --version)"
          '';
        };
      });
}
