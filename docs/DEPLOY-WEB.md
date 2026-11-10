# Putting the web app on your website

The web app is five static files in `web/` (`index.html`, `styles.css`, `app.js`, `engine.js`, `worklet.js`). There's no server code and no database. All audio stays in the visitor's browser, and calibrations are saved in their browser too.

Squarespace can't host JavaScript files like these, so the app lives on GitHub Pages (free, HTTPS) and your Squarespace site links to it or embeds it.

## 1. Publish on GitHub Pages

1. Push this repo to GitHub, for example `github.com/JSFWatch/JSFtimegrapher`.
2. In the repo, open **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`. The `pages` workflow tests the engine and publishes `web/`.
4. The app is live at `https://jsfwatch.github.io/JSFtimegrapher/`.

## 2. Optional: give it your own address

`timegrapher.jsfwatch.com` looks better than a github.io link, and visitors only grant microphone access to your domain.

1. Wherever jsfwatch.com's DNS is managed (Squarespace Domains if you bought it there), add a record:
   - Type: `CNAME`
   - Host: `timegrapher`
   - Value: `jsfwatch.github.io`
2. Create `web/CNAME` containing one line: `timegrapher.jsfwatch.com`, then commit and push.
3. In **Settings > Pages**, enter `timegrapher.jsfwatch.com` as the custom domain and tick **Enforce HTTPS** once it's offered (DNS can take up to a day).

## 3. Add it to jsfwatch.com

**Simplest: a link.** Add `https://timegrapher.jsfwatch.com` (or the github.io address) to your site navigation or service page. The app opens full screen, which is best on a bench laptop.

**Or embed it in a page.** Add a Code Block to a Squarespace page (Code Blocks depend on your Squarespace plan) and paste:

```html
<iframe
  src="https://timegrapher.jsfwatch.com/"
  title="JSF Timegrapher"
  allow="microphone"
  style="width:100%; height:1150px; border:0; display:block;">
</iframe>
```

`allow="microphone"` is required. Without it the browser blocks the pickup inside the embed.

## Things visitors should know

- **HTTPS only.** Browsers only allow microphone access on secure pages. GitHub Pages and Squarespace are both HTTPS.
- **Supported browsers:** current Chrome, Edge, Firefox and Safari on desktop. Phones work, but the built-in mic is a poor pickup.
- **Calibration is per browser and per input.** A new laptop, browser or USB interface means a new calibration. Clearing site data erases saved calibrations.
- **GPS calibration needs a stereo input** with the 1 PPS signal on input 2. Many cheap USB dongles are mono, so use the quartz method on those.
- **Phones can't use their own GPS for calibration.** Browsers only get location from it, not the timing pulse. On a phone, use a quartz watch or the device clock method.
- **Device clock method:** compares the sound card with the phone or computer's network time for 30 minutes. No reference watch needed, but it's only as good as the device's time sync, and it hasn't been checked against a reference on real phones yet. Use quartz or GPS when accuracy matters most. The screen is kept on during the run where the browser allows it.
- **Phone mics are weak pickups.** They hear the room as much as the watch. A contact pickup on a USB-C or Lightning audio adapter works far better.
- **The browser's audio processing is switched off** (echo cancellation, noise suppression, auto gain). If an OS-level "enhancement" is enabled for the device, turn it off too, since it can smear the tick sounds.
