class RxRequests {
    static get = (url) => {
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.hostname === "api.modrinth.com") {
                return new Promise((resolve) => {
                    request.get({
                        url,
                        json: true,
                        gzip: true,
                        timeout: 15000,
                        headers: {
                            "User-Agent": `MaxRx/RxLauncher/${LAUNCHER_VERSION} (${SITE_URL})`
                        }
                    }, (error, response, body) => {
                        if (error || !response || response.statusCode < 200 || response.statusCode >= 300) {
                            resolve([false, error || response]);
                            return;
                        }
                        resolve([true, body]);
                    });
                });
            }
        } catch (_) {}

        return new Promise(resolve => {
            $.get(url, (response) => {
                resolve([true, response]);
            }).fail(e => {
                resolve([false, e]);
            })
        })
    }

    static post = (url, data = {}, contentType = false, processData = false) => {
        return new Promise(resolve => {
            $.ajax({
                url: url,
                type: "POST",
                data: data,
                success: (response) => {
                    resolve([true, response]);
                },
                error: (e) => {
                    console.error(e);
                    resolve([false, e]);
                },
                processData: processData,
                contentType: contentType
            });
        })
    }
}
