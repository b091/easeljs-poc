import {Hotspot} from './Hotspot.js';

export class Pages {

    static createPages(pictures) {
        for (let index = 0; index < pictures.length; index++) {
            stage.addChild(Pages.createPage(pictures[index], index));
        }
    }

    static createPage(src, index) {
        let container = Pages.createPageContainer(src, index);
        container.addChild(new createjs.Bitmap(src));

        for (let xyz = 0; xyz <= 50; xyz++) {
            Pages.createHotSpot(container);
        }

        return container;
    }

    static createHotSpot(container) {
        let picture = new Image();
        let index = Math.floor(Math.random() * 3) + 1;
        picture.src = "img/hotspot_" + index + ".jpeg";
        picture.onload = () => {
            let hotspot = new Hotspot(picture);
            container.addChild(hotspot);
            Hotspot.setRandomPosition(hotspot);
            stage.update();
        };
    }

    static createPageContainer(picture, index) {
        let container = new createjs.Container();
        let ratio = Math.min(window.innerWidth / picture.width, window.innerHeight / picture.height);
        let rectWidth = ratio * picture.width;

        container.scaleX = container.scaleY = window.innerHeight / picture.height;
        container.x = (picture.width - rectWidth) * index;
        container.y = 0;

        return container;
    }

}


