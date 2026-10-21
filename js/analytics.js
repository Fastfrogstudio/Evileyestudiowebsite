/**
 * Google Analytics 4 — visitor measurement for evileyestudio.
 *
 * Loaded from the <head> of every page. The measurement ID lives here and only
 * here: the site is hand-written HTML with no build step, so pasting Google's
 * inline snippet into each page would mean two copies of the ID to keep in step,
 * and a third the day a page is added.
 *
 * ── Getting the ID ──────────────────────────────────────────────────────────
 * analytics.google.com -> Admin -> Data streams -> your web stream. The ID is
 * shown top-right and looks like G-ABC1234XYZ. It is not a secret: it ships in
 * the page source of every site that uses GA, and it only identifies which
 * property to report to.
 *
 * ── Why the placeholder guard ───────────────────────────────────────────────
 * Left unset this file does nothing and says so in the console. The alternative
 * — shipping Google's snippet with the placeholder still in it — loads the
 * tag library on every visit and posts hits to a property that does not exist,
 * which looks exactly like working analytics right up until someone opens the
 * dashboard and finds it empty.
 */
(function () {
	'use strict';

	/* GA4 measurement ID — property "evil eye studio", web stream. */
	var MEASUREMENT_ID = 'G-BL9CQ4CVWP';

	var PLACEHOLDER = 'G-XXXXXXXXXX';

	if (!MEASUREMENT_ID || MEASUREMENT_ID === PLACEHOLDER) {
		// Deliberately a warning and not a silent return: the whole failure mode
		// this guards against is analytics that look installed and measure nothing.
		if (window.console && console.warn) {
			console.warn(
				'[analytics] Google Analytics is not active yet. Set MEASUREMENT_ID in js/analytics.js ' +
					'to your GA4 stream ID (Admin -> Data streams), then redeploy.',
			);
		}
		return;
	}

	// Google's own bootstrap, verbatim in behaviour: dataLayer must exist and
	// gtag() must be callable BEFORE the tag library arrives, because calls made
	// while it loads are queued in dataLayer and replayed once it does. Defining
	// these after the script tag would drop the initial page_view on a slow
	// connection.
	window.dataLayer = window.dataLayer || [];
	function gtag() {
		window.dataLayer.push(arguments);
	}
	window.gtag = gtag;

	gtag('js', new Date());
	gtag('config', MEASUREMENT_ID);

	var tag = document.createElement('script');
	tag.async = true;
	tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
	document.head.appendChild(tag);
})();
