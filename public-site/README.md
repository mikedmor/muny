# Muny's public site

Muny's home page, at [mikedmor.github.io/muny](https://mikedmor.github.io/muny/): what it does, screenshots
and how to install it. It's plain HTML with no build step and no cookies. Its one outside script is GoatCounter, which counts visits anonymously.

The workflow `.github/workflows/public-site.yml` publishes this folder, and only this folder, whenever
it or the guides' screenshots change on `main`. In the repository's **Settings → Pages**, **Source** must be **GitHub Actions**.

The app screenshots in `app/` are the Android app's Play Store pictures, made smaller. The other screenshots are the guides' own: the workflow copies `guides/images/` into `shots/` when it
publishes, and publishes again whenever they change, so the site keeps up with the guides. They use
Muny's built-in demo household; all names and numbers are invented. To preview the site locally, copy
them in yourself (`shots/` is ignored by git):

```sh
mkdir -p public-site/shots && cp guides/images/*.png public-site/shots/
```

## The guide

`guide/` is built from `guides/*.md` when the site deploys, by guide-kit
([mikedmor.github.io/tools/guide-kit](https://github.com/mikedmor/mikedmor.github.io/tree/main/tools/guide-kit)),
using `guide.json` for Muny's name, colours and logo (`guide-logo.svg`). The contents and the front page
come from the tables in `guides/README.md`. `guide/` is ignored by git. To build it locally, with both
repositories side by side:

```sh
npm ci --prefix ../mikedmor.github.io/tools/guide-kit
node ../mikedmor.github.io/tools/guide-kit/build.mjs public-site/guide.json
```
