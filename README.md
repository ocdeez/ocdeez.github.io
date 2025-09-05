# stancfhole.com on GitHub Pages

This repo is ready to publish as a **user site** at `https://ocdeez.github.io` and mapped to **stancfhole.com**.

## Publish
1. Create a public repository named **ocdeez.github.io**.
2. Upload these files to the root of that repo and commit.
3. (In the repo) go to **Settings → Pages → Custom domain** and enter **stancfhole.com**. This ensures the `CNAME` file is set.

## DNS (set at your domain registrar)
For the apex domain **stancfhole.com** add these records:

**A (IPv4)**
- 185.199.108.153
- 185.199.109.153
- 185.199.110.153
- 185.199.111.153

**AAAA (IPv6)**
- 2606:50c0:8000::153
- 2606:50c0:8001::153
- 2606:50c0:8002::153
- 2606:50c0:8003::153

(Optional) For **www.stancfhole.com**, create a **CNAME** pointing to **ocdeez.github.io**.

## HTTPS
After GitHub verifies the domain, enable **Enforce HTTPS** in **Settings → Pages**.

## Customize
- Edit `index.html`, `about.html`, and `styles.css`.
- Keep `.nojekyll` and `404.html`.
