# Ava's add-on catalogue

The list of add-ons [Ava](https://github.com/avacanada/ava) can install, and
the tools that turn it into what Ava downloads. It works like Zed's extension
registry: publishing an add-on is a reviewed PR here, and CI builds it from
the exact commit that PR pins.

```
addons/<id>.toml     one entry per add-on: repo, commit, version, what it asks for
tools/pack/          the packer (TypeScript, Node 24): fetch, build, check, pack, index, sign
tools/verify/        an independent verifier (Python 3.11+ and OpenSSL 3)
vectors/             golden packages and indexes, signed with the TEST key
patches/             the test (and production key) for avacanada/ava that checks vectors/
```

What Ava downloads is served from `https://ava-releases.addis.gg/catalogue/`
(R2 bucket `ava-releases`, APS 12), which is `CATALOGUE_URL` in Ava's
`src-tauri/src/addons/catalogue.rs`.

## Publishing an add-on

1. The add-on lives in its own repo with a `package-lock.json`, and
   `npm ci --ignore-scripts && npm run build` writes its bundle to `dist/`,
   with `dist/manifest.json` (Ava's manifest format, `manifest.rs`). Its
   version is the manifest's `version`. Notebook
   ([avacanada/ava-notebook](https://github.com/avacanada/ava-notebook)) is
   the example.
2. Open a PR here that adds or changes `addons/<id>.toml`:

   ```toml
   repo = "avacanada/ava-notebook"          # owner/name on github.com
   commit = "<the full 40-character SHA>"   # built from exactly this commit
   version = "0.1.0"                        # the manifest's version at that commit
   publisher = "Addis"                      # shown as "From Addis" in Ava's install prompt
   permissions = ["files", "storage", "tools"]
   egress = []                              # hosts it may reach, in the manifest's order

   [[tools]]                                # every tool, in the manifest's order
   name = "search"
   effect = "read"                          # read | inside | outside
   ```

   The permissions, tools and egress hosts are there so the reviewer reads,
   in the diff, exactly what Ava's install prompt will say. CI fails if the
   built manifest says anything else.

   `repo` is part of the signed package too (the listing's `repo` and
   default `homepage` are built from it), so a published version keeps the
   `repo` it was published with. When an add-on's repo moves, change `repo`
   together with a new `version`.

   The add-on's repo also has a **listing** in `listing/` (see below): what
   the website, Ava's Settings › Add-ons and her marketplace tools show.
3. The PR's CI (`.github/workflows/pr.yml`, on a mirab VM) builds every
   changed add-on from its pinned commit in a clean directory, checks the
   manifest by Ava's rules and against the entry, packs it, signs it with the
   test key and verifies it with `tools/verify`. It also refuses a version
   that's already published with other bytes: every change needs a new
   version.
4. A reviewer merges it. The release workflow builds everything again, signs
   it with the production key and publishes it.

Ids are `[a-z0-9-]{3,32}`; `ava`, `ava-*` and `addis-*` are reserved for
add-ons that ship inside Ava and are refused here.

## The listing

Every add-on's repo has `listing/listing.toml`, read at the pinned commit
(the fetch step copies it before the add-on's own build runs, so the build
can't change it):

```toml
category = "notes"            # notes writing files media design developer productivity learning other
icon = "icon.svg"             # in listing/: an .svg (≤ 64 KiB, a picture only) or a square .png (64–1024 px)
homepage = "https://…"        # optional; the repo's page when left out
long_description = """
Plain text, paragraphs split by a blank line, at most 4000 characters."""

[[screenshots]]               # 0 to 4: PNG, ≤ 1 MiB, 320–2560 wide and 200–1600 high
file = "screenshot-read.png"
caption = "One line, at most 120 characters."
```

The name, version and short description stay in the manifest. An SVG icon
must be a picture and nothing else: no script, event handlers, foreign HTML,
DTD, or reference outside itself (only `#…` hrefs and `url(#…)`). The packer
names the assets itself (`icon.svg` or `icon.png`, `screenshot-1.png`…),
copies the checked listing into the package (`listing/listing.json` and
`listing/<asset>`; a bundle may not have its own `listing/`) and into the
index entry, and serves each asset at `assets/<id>/<version>/<asset>` with
its sha256 in the index. Ava checks the package's listing is the index's,
and every picture against its sha256 each time it shows one.

## The format

Every file is what `catalogue.rs` reads, byte for byte what serde_json would
write. Under `https://ava-releases.addis.gg/catalogue/`:

| file | what | cache |
|---|---|---|
| `<id>-<version>.avapkg` + `.sig` | a package | immutable |
| `assets/<id>/<version>/<asset>` | a listing's icon and screenshots | immutable |
| `index/<version>.json` + `.sig` | the index, format 2, with listings | immutable |
| `latest.json` | the pointer: which index is current | no-cache |
| `index.json` + `.sig` | the same index in format 1, for older Avas | no-cache |

- **A package**: compact JSON
  `{"format":1,"id":"…","version":"…","files":{"<path>":"<base64>",…}}`, the
  bundle's files (and its `listing/`) by `/`-separated path in byte order.
  No symlinks, no path outside the bundle.
- **The index**, `index/<version>.json`: pretty JSON (two spaces) with
  `format` 2, a `version`, the `published` date and one entry per add-on:
  `id`, `name`, `version`, `publisher`, `description`, `permissions`,
  `tools` (`name`, `description`, `effect`), `egress`, `package` (`file`,
  `sha256`, `bytes`) and `listing` (`long_description`, `category`,
  `homepage`, `repo`, `icon` {`file`, `sha256`, `bytes`}, `screenshots`
  [{`file`, `sha256`, `bytes`, `width`, `height`, `caption`}]). Names,
  descriptions and tool descriptions come from the manifest; `publisher`
  from the entry; the listing from `listing/`.
- **The pointer**, `latest.json`: `{"format":2,"version":N,"index":"index/N.json","sha256":…,"bytes":…,"signature":…}`,
  the index's sha256, size and signature. One file, written in one PUT,
  after the index it names: Ava can never read an index with another's
  signature (which `index.json` and `index.json.sig`, two files, allow for
  a moment on every release). Everything in it is checked against the
  signed index (its bytes, its version), so it needs no signature of its own.
- **The legacy index**, `index.json`: the same index in format 1, without
  listings (Avas from before the pointer refuse unknown fields). Ava reads
  it only when there's no `latest.json` (a 404), never because fetching
  `latest.json` failed.
- **Signatures**, `<file>.sig` (and the pointer's `signature`): the raw
  64-byte Ed25519 signature of the file's exact bytes, in standard base64.

**The index version only goes up.** It is the merge commit's time in seconds.
Ava refuses an index older than one it has accepted; the release refuses to
publish one older than what's live, and one with the live version that says
something else (the first format 2 index may share its version with the last
format 1 one, if it says the same). A published package or asset never
changes its bytes.

### Two implementations, one format: the vectors

The packer is TypeScript, Ava's verifier is Rust. `vectors/` is how they're
kept in step:

- `vectors/fixtures/`: two small add-ons, their entries and their listings
  (`<id>.listing/`: paths that sort differently as bytes and as a JavaScript
  object would, a tab, quotes and non-ASCII text, a beta version, egress
  hosts, an SVG and a PNG icon, a screenshot and none).
- `vectors/good/`: their packages, assets, both indexes (version 100) and
  the pointer, signed with the test key (`catalogue.rs` `test_key::SEED`,
  public on purpose).
- `vectors/bad/`: `tampered-package`, `wrong-signature` (both indexes signed
  by another key), `rollback` (version 99 after 100), `manifest-mismatch`
  (the index asks for less than the package's manifest), `pointer-hash`
  (latest.json's sha256 isn't the index's), `pointer-version` (latest.json
  says 101, the index is 100), `listing-mismatch` (the index's listing isn't
  the package's) and `asset-tampered` (an icon changed after it was recorded).
- `vectors/cases.json`: which is which, and by which way in (`latest`, or
  `both` with `index.json`).

`npm run vectors` makes them; CI fails if they're not current.
`patches/ava-catalogue-vectors.patch` copies them into avacanada/ava with a
test (`src-tauri/src/addons/catalogue_vectors.rs`) that checks each file is
what serde_json writes, each signature is what `test_key::sign` makes, the
good ones install and each bad one is refused for its reason. CI here checks
the patch carries exactly these vectors. When the format changes, remake the
vectors and the patch together.

## Trust model

- **One signing key, held only by CI.** The production seed is the secret
  `CATALOGUE_SIGNING_KEY` in this repo's `release` environment, which only
  `main` can use (Sami's decision). No person or other workflow has it. Ava
  carries the public key
  (`b4dde9d1fc109c2bed7459046e7848ee6e96459a4cbff867b3de37f3ef78a0e5`).
- **What gets signed is what was reviewed.** An entry pins a full commit; the
  release builds from exactly that commit, checks the built manifest against
  the entry, and signs the result. The index carries every package's sha256
  and size; Ava also checks the package's manifest asks for exactly what the
  index (and so its install prompt) says.
- **The add-on's build never sees the key.** In the release job, sources are
  fetched (a private one with its deploy key or the optional read token,
  neither of which git or the build sees in its environment; see
  [Private add-ons](#private-add-ons)), then built as a separate user with a
  bare environment and no secrets; every process of that user is killed
  before the signing step, the only step given the key (as an environment
  variable, never an argument, never logged).
- **Nothing counts until it's read back.** After uploading (packages and
  assets, then `index/<version>.json`, then `latest.json`, then `index.json`
  for older Avas, so nothing ever points at a file that isn't there yet) the
  release downloads every file from `ava-releases.addis.gg`, compares the
  bytes and verifies them against the production key with `tools/verify`, by
  both ways in, which must agree (APS 9).
- **The PR workflow has no signing key**: it signs with the test key, and its
  only secrets read private add-on repos (deploy keys, the read token), and
  only its fetch step gets them.

### Rotating the key

Ava carries one key today. To rotate without breaking installs, Ava should
carry two, **current** and **next**, and accept either (a follow-up for
avacanada/ava). Then:
1. Generate the next key pair; ship an Ava release that carries its public
   key as `next`.
2. Once that release is out, put the next seed in `CATALOGUE_SIGNING_KEY`,
   change `PRODUCTION_KEY` in the workflows, and run the release: everything
   is re-signed with it (packages keep their bytes; only `.sig` files change).
3. The next Ava release moves it to `current` and drops the old key.

A leaked key is the same, faster, plus a new index version so caches move on.

## Workflows

| workflow | when | runner | secrets |
|---|---|---|---|
| `pr.yml` | every PR | `ubuntu-24.04`, GitHub-hosted: a public repo (APS 11) | `ADDON_DEPLOY_KEY_<ID>` per private add-on, `ADDON_SOURCE_TOKEN` (optional); fetch step only |
| `release.yml` | push to `main` | `ubuntu-24.04`, GitHub-hosted: a publish job (APS 11) | `release` environment: `CATALOGUE_SIGNING_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`; plus `ADDON_DEPLOY_KEY_<ID>` and `ADDON_SOURCE_TOKEN` (fetch step only) |

The release fails closed, before building anything, when any of the release
secrets is missing, and says which. A private add-on repo can't be fetched
without its deploy key (or `ADDON_SOURCE_TOKEN`); the error names the secret
to set.

## Private add-ons

A private add-on repo is read with a **deploy key of its own**: read-only, on
that one repo, and nothing else. The packer looks for it in
`ADDON_DEPLOY_KEY_<ID>`, the entry's id upper-cased with anything not A-Z or
0-9 made `_` (`canvas` → `ADDON_DEPLOY_KEY_CANVAS`, `my-notes` →
`ADDON_DEPLOY_KEY_MY_NOTES`). With it set, `fetch` reads
`git@github.com:<repo>.git` over SSH with that key alone: written to a 0600
file in a 0700 directory, named to git only by `GIT_SSH_COMMAND`
(`-F /dev/null`, `IdentitiesOnly`, no agent, `StrictHostKeyChecking=yes`
against github.com's host keys pinned in `tools/pack/github_known_hosts`), and
deleted when the fetch ends, whether it worked or not. git's environment
never holds a deploy key or the token, and the build never sees either. Without
one, the fetch is HTTPS as before (with `ADDON_SOURCE_TOKEN` if it's set).

The secrets are repo secrets, so the PR workflow and the release job both get
them; a PR from a fork gets none. To add one (canvas as the example; it needs
admin on both repos):

1. **Generate a key** in a private directory of your own (not a shared temp
   directory), with no passphrase, since CI can't type one:
   ```sh
   ssh-keygen -t ed25519 -N '' -C 'ava-catalogue read canvas' -f ./canvas_deploy_key
   ```
2. **Add the public half as a read-only deploy key** on the add-on's repo
   (the avacanada org allows deploy keys), and check that it worked:
   ```sh
   gh repo deploy-key add ./canvas_deploy_key.pub -R avacanada/ava-canvas --title 'ava-catalogue (read)'
   gh repo deploy-key list -R avacanada/ava-canvas      # it's listed, read-only
   ```
   `deploy-key add` is read-only unless you pass `--allow-write`; never do.
   **Don't go on until this succeeded.** If GitHub refused the key (deploy keys
   disabled, the key already used on another repo, no admin), storing the
   private half anyway gives a secret that opens nothing, and the fetch fails
   later with a less obvious message. This has happened twice, with scripts
   that set the secret without checking the add.
3. **Store the private half** as the catalogue's repo secret, from the file,
   so it's never echoed, typed or in your shell history:
   ```sh
   gh secret set ADDON_DEPLOY_KEY_CANVAS -R avacanada/ava-catalogue < ./canvas_deploy_key
   ```
4. **Add one line to the fetch step** of both `.github/workflows/pr.yml` and
   `.github/workflows/release.yml`, next to `ADDON_SOURCE_TOKEN`, and nowhere
   else:
   ```yaml
             ADDON_DEPLOY_KEY_CANVAS: ${{ secrets.ADDON_DEPLOY_KEY_CANVAS }}
   ```
5. **Delete the local key**: GitHub holds the only copies it needs.
   ```sh
   rm ./canvas_deploy_key ./canvas_deploy_key.pub
   ```

To revoke: delete the deploy key on the add-on's repo, then the secret here.
If github.com rotates its SSH host keys, update `tools/pack/github_known_hosts`
from https://api.github.com/meta (and check the fingerprints GitHub publishes)
in a reviewed PR.

## Working on it

```sh
npm ci --ignore-scripts
npm run check            # tsc
npm test                 # the packer (and that the patch carries vectors/)
npm run test:verify      # the verifier against vectors/
npm run validate         # every entry
npm run vectors          # remake vectors/ (commit them, and remake the patch)

# The whole pipeline, as the PR workflow runs it, signed with the test key:
node tools/pack/main.ts fetch --work work
node tools/pack/main.ts build --work work
node tools/pack/main.ts pack --work work --out out
node tools/pack/main.ts index --out out --version next --published 2026-11-11
node tools/pack/main.ts sign --dir out --test-key --expect 2cc39b7391346c1dd3c5c630cac5e99d5efe54c2a26b3249f7488ec62675d0af
python3 -I tools/verify/verify.py --key 2cc39b7391346c1dd3c5c630cac5e99d5efe54c2a26b3249f7488ec62675d0af --dir out --entries addons
```

**Why TypeScript for the packer:** add-ons are npm projects built with Node,
so the packer needs Node anyway; Node has Ed25519 and SHA-256 built in, so it
has one dependency (a TOML parser); and CI compiles no Rust. The verifier is
Python with OpenSSL so it shares no code, language or crypto library with the
packer, and Ava's Rust is the third check, through the vectors.

## License

MIT, see [LICENSE](LICENSE) (Addis APS 17). The catalogue is public: its
entries, the packer, the verifier and the vectors are MIT (Sami, 13 Nov,
reversing avacanada/ava-catalogue#5 for this repo only). The add-ons it lists
keep their own licences, and the catalogue accepts any: Ava's first-party
add-ons (Notebook, Create, Canvas) are proprietary, like Ava (Ava APS 1,
avacanada/aps#1). The add-on SDK,
[@avacanada/ava-addon](https://github.com/avacanada/ava-addon), is MIT.
