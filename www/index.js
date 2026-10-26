// www.iwonderful.okinawa/… → https://iwonderful.okinawa/…（パスと ?… はそのまま）
export default {
	fetch(request) {
		const u = new URL(request.url);
		u.protocol = "https:";
		u.hostname = "iwonderful.okinawa";
		u.port = "";
		return Response.redirect(u.toString(), 301);
	},
};
