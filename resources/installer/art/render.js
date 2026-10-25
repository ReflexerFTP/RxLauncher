// Арт установщика: парящий остров из тёмных кубов с красной подсветкой на чёрном фоне.
// Рендерится в Electron (render-art.cjs), детерминированно — одинаковый результат при каждом запуске.
(() => {
    const ACCENT = 0xe53935;

    // Детерминированный генератор, чтобы картинка не менялась от сборки к сборке
    const random = (() => {
        let seed = 20261025;
        return () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
    })();

    const buildScene = () => {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000);
        scene.fog = new THREE.Fog(0x000000, 30, 52);

        const dark = new THREE.MeshStandardMaterial({color: 0x24242a, roughness: 0.5, metalness: 0.12});
        const darker = new THREE.MeshStandardMaterial({color: 0x16161a, roughness: 0.65, metalness: 0.1});
        const glow = new THREE.MeshStandardMaterial({color: 0x2a0606, emissive: ACCENT, emissiveIntensity: 2.2, roughness: 0.4});
        const box = new THREE.BoxGeometry(1, 1, 1);
        const island = new THREE.Group();

        // Остров: верхний слой — плато, снизу сужается каплей, как парящий кусок мира
        const radius = 4.2;
        for (let x = -5; x <= 5; x++) {
            for (let z = -5; z <= 5; z++) {
                const distance = Math.hypot(x, z * 1.05);
                if (distance > radius + random() * 0.6) continue;
                const height = Math.round((radius - distance) * 1.25 + random() * 1.4);
                const top = Math.round(random() * 0.9 + (distance < 1.5 ? 1 : 0));
                for (let y = -height; y <= top; y++) {
                    const isGlow = y < top && y > -height + 1 && random() < 0.035;
                    const cube = new THREE.Mesh(box, isGlow ? glow : (y === top ? dark : darker));
                    cube.position.set(x, y, z);
                    island.add(cube);
                }
            }
        }

        // Монолит в центре — главный акцент
        for (let y = 2; y <= 6; y++) {
            const cube = new THREE.Mesh(box, y === 6 ? glow : dark);
            cube.position.set(0, y, 0);
            island.add(cube);
        }

        // Осколки вокруг острова
        for (let i = 0; i < 26; i++) {
            const size = 0.18 + random() * 0.55;
            const shard = new THREE.Mesh(box, random() < 0.2 ? glow : dark);
            const angle = random() * Math.PI * 2;
            const distance = 5.5 + random() * 4.5;
            shard.scale.setScalar(size);
            shard.position.set(Math.cos(angle) * distance, -4 + random() * 11, Math.sin(angle) * distance);
            shard.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
            island.add(shard);
        }
        island.rotation.y = Math.PI / 4.6;
        scene.add(island);

        // Свет: красный контровой снизу-сзади, холодный рисующий сверху, слабое заполнение
        const rim = new THREE.PointLight(ACCENT, 1300, 0, 2);
        rim.position.set(-7, -4, -6);
        scene.add(rim);
        const rim2 = new THREE.PointLight(ACCENT, 600, 0, 2);
        rim2.position.set(8, 2, -4);
        scene.add(rim2);
        const key = new THREE.DirectionalLight(0xe6ebff, 2.4);
        key.position.set(5, 14, 9);
        scene.add(key);
        scene.add(new THREE.HemisphereLight(0x3a3a46, 0x050505, 1.1));
        // Свет от монолита
        const core = new THREE.PointLight(ACCENT, 380, 0, 2);
        core.position.set(0, 7.4, 1.2);
        scene.add(core);
        return scene;
    };

    // Свечение, виньетка и зерно поверх 3D
    const postProcess = (source, width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(source, 0, 0);
        // Мягкое свечение: размытая копия светлых участков, сложением
        ctx.globalCompositeOperation = "lighter";
        ctx.filter = `blur(${Math.round(width / 40)}px) brightness(0.9)`;
        ctx.globalAlpha = 0.55;
        ctx.drawImage(source, 0, 0);
        ctx.filter = "none";
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        // Виньетка
        const vignette = ctx.createRadialGradient(width / 2, height * 0.45, Math.min(width, height) * 0.25, width / 2, height / 2, Math.max(width, height) * 0.75);
        vignette.addColorStop(0, "rgba(0,0,0,0)");
        vignette.addColorStop(1, "rgba(0,0,0,0.85)");
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, width, height);
        // Плавный уход в чёрный снизу — под этой зоной у окна нет текста, но край мягче
        const fade = ctx.createLinearGradient(0, height * 0.82, 0, height);
        fade.addColorStop(0, "rgba(0,0,0,0)");
        fade.addColorStop(1, "rgba(0,0,0,0.9)");
        ctx.fillStyle = fade;
        ctx.fillRect(0, 0, width, height);
        // Зерно
        const image = ctx.getImageData(0, 0, width, height);
        for (let i = 0; i < image.data.length; i += 4) {
            const noise = (random() - 0.5) * 10;
            image.data[i] = Math.max(0, Math.min(255, image.data[i] + noise));
            image.data[i + 1] = Math.max(0, Math.min(255, image.data[i + 1] + noise));
            image.data[i + 2] = Math.max(0, Math.min(255, image.data[i + 2] + noise));
        }
        ctx.putImageData(image, 0, 0);
        return canvas;
    };

    const render = (width, height, camera) => {
        const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
        renderer.setPixelRatio(1);
        renderer.setSize(width, height);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.15;
        const scene = buildScene();
        renderer.render(scene, camera);
        const result = postProcess(renderer.domElement, width, height);
        renderer.dispose();
        return result;
    };

    // Вертикальная панель окна установщика (и боковая картинка NSIS)
    window.renderPortrait = (width, height) => {
        const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 100);
        camera.position.set(0, 5, 33);
        camera.lookAt(0, 0.4, 0);
        return render(width, height, camera).toDataURL("image/png");
    };

    // Узкая шапка NSIS: остров справа, слева пусто под текст
    window.renderBanner = (width, height) => {
        const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
        camera.position.set(-9, 2, 24);
        camera.lookAt(-9, 1.2, 0);
        return render(width, height, camera).toDataURL("image/png");
    };
})();
