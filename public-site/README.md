# Muny's public site

Muny's home page, at [mikedmor.github.io/muny](https://mikedmor.github.io/muny/): what it does, screenshots
and how to install it. It's plain HTML with no build step, no tracking, cookies or outside scripts.

The workflow `.github/workflows/public-site.yml` publishes this folder, and only this folder, whenever
it or the guides' screenshots change on `main`. In the repository's **Settings → Pages**, **Source** must be **GitHub Actions**.

The screenshots are the guides' own: the workflow copies `guides/images/` into `shots/` when it
publishes, and publishes again whenever they change, so the site keeps up with the guides. They use
Muny's built-in demo household; all names and numbers are invented. To preview the site locally, copy
them in yourself (`shots/` is ignored by git):

```sh
mkdir -p public-site/shots && cp guides/images/*.png public-site/shots/
```
