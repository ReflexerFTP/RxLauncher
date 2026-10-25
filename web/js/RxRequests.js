class RxRequests {
    static get = (url) => {
        try {
            const parsedUrl = new URL(url);
            // Modrinth просит представляться своим User-Agent — браузерный запрос его не передаёт
            if (parsedUrl.hostname === "api.modrinth.com") {
                return RxHttp.json(url, {timeout: 15000})
                    .then(body => [true, body])
                    .catch(error => [false, error]);
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
