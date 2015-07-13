import {Hotspot} from './Hotspot.js';

export class Pages {

    static createPages(pictures) {
        let picture = new Image();
        picture.src = "img/hotspot.jpeg";
        picture.onload = () => {
            for (let i = 0; i < pictures.length; i++) {
                Pages.createPage(pictures[i], i, picture);
            }
            stage.update();
        };
    }

    static createPage(src, i, picture) {
        let container, hotspot;
        container = Pages.createPageContainer(src, i);
        for (let xyz = 0; xyz <= 50; xyz++) {
            hotspot = new Hotspot(picture);
            container.addChild(hotspot);
            Hotspot.setRandomPosition(hotspot);
        }
        stage.addChild(container);
    }


    static createPageContainer(picture, i) {

        let container = new createjs.Container();
        let bitmap = new createjs.Bitmap(picture);
        let ratio = Math.min(window.innerWidth / picture.width, window.innerHeight / picture.height);
        let rectWidth = ratio * picture.width;

        container.scaleX = window.innerWidth / picture.width;
        container.scaleY = window.innerHeight / picture.height;
        container.x = (picture.width - rectWidth) * i;
        container.y = 0;
        container.addChild(bitmap);

        return container;
    }


}


